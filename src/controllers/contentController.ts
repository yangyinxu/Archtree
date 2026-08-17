import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { Album } from '../models/album';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { Carousel } from '../models/carousel';
import { Page } from '../models/page';
import { ContentCollection } from '../models/contentCollection';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { parseBuffer, parseFile } from 'music-metadata';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { escapeHtml } from '../views/html';
import { renderAudioTracksPage } from '../views/contentManager/audioTracksView';
import {
    formatStorageSize,
    loadS3StorageSummary,
    S3StorageSummary
} from '../services/s3StorageService';
import {
    formatDuration,
    inferAudioFormat,
    titleFromFileName
} from '../services/audioMetadataService';
import {
    deleteAudioObjectAndTrack,
    uploadAudioObject
} from '../services/audioStorageService';
import { validateContentReferences } from '../services/contentReferenceService';
import {
    attachCoverArtToNewOwner,
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt,
    validateCoverArtFile
} from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';
import { boundedSearchQuery } from '../utils/search';
import { getRequestAbortSignal } from '../middleware/requestProtectionMiddleware';
import { renderPageItemsHierarchy } from '../views/contentManager/pageItemsView';
import { renderReleaseOperations } from '../views/contentManager/releaseOperationsView';
import {
    ManagementInventoryPage,
    managementInventoryOffset,
    managementInventoryPageSize,
    normalizeManagementInventoryPage,
    toManagementInventoryPage
} from '../views/contentManager/inventoryPagination';
import { getPublicOrganization, searchPublicCatalog } from '../services/publicCatalogService';
import { boundedLimit } from '../utils/pagination';
import { deleteArtistAndReferences } from '../services/artistLifecycleService';
import { deleteAlbumAndReferences } from '../services/albumLifecycleService';
import {
    linkReadyAudioTracksToAlbum,
    publishUploadedAudioTracks
} from '../services/albumTrackLinkService';
import { retryAudioTrackPublications } from '../services/audioPublicationRecoveryService';
import { publishNewArtist } from './artistController';
import { publishNewAlbum } from './albumController';
import {
    replaceArtistAlbums
} from '../services/artistAlbumLinkService';
import {
    ensureAlbumPrimaryArtistCredit,
    removeAlbumPrimaryArtistCredit
} from '../services/catalogCreditService';
import {
    ArtistReleaseWorkflowResult,
    listArtistReleaseOperations,
    resumeArtistReleaseWorkflow,
    runArtistReleaseWorkflow
} from '../services/artistReleaseWorkflowService';
import {
    creditsForLegacyArtistIds,
    mergeLegacyArtistIdsIntoCredits,
    migratedCatalogCreditId,
    normalizeCatalogCredits
} from '../models/catalogCredit';
import {
    catalogCreditRoles,
    catalogCreditSubjectTypes,
    createCatalogCreditId
} from '../models/catalogCredit';
import { Organization, organizationTypes } from '../models/organization';
import { deleteUnreferencedOrganization } from '../services/organizationLifecycleService';
import {
    addCatalogCredit,
    addSoundtrackCredit,
    removeCatalogCredit,
    reorderCatalogCredits,
    replaceCatalogCredits
} from '../services/catalogCreditService';

const parseCsv = (value: string) => {
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean) as [string];
};

const parseDateInput = (value: string) => {
    if (!value) {
        return new SimpleDate();
    }

    const [yearRaw, monthRaw, dayRaw] = value.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
        return new SimpleDate();
    }

    return new SimpleDate(year, month, day);
};

const toCsvInput = (value: unknown) => {
    if (!Array.isArray(value)) {
        return '';
    }

    return value.map((item) => String(item)).join(', ');
};

const toDateInputValue = (value: any) => {
    const year = Number(value?.year);
    const month = Number(value?.month);
    const day = Number(value?.day);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) || year <= 0 || month <= 0 || day <= 0) {
        return '';
    }

    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const uniqueStrings = (values: string[]) => {
    return [...new Set(values.filter(Boolean))];
};

const inventoryQueryNames = {
    artists: 'artistsPage',
    organizations: 'organizationsPage',
    albums: 'albumsPage',
    audioTracks: 'audioTracksPage',
    pages: 'pagesPage',
    carousels: 'carouselsPage',
    contentCollections: 'contentCollectionsPage'
} as const;

type InventoryKey = keyof typeof inventoryQueryNames;
type InventoryPaginationEntry = Omit<ManagementInventoryPage<unknown>, 'items'>;
type InventoryPagination = Record<InventoryKey, InventoryPaginationEntry>;
type ManagerView = 'overview' | 'catalog' | 'layout' | 'operations';

const managerViewFromQuery = (value: unknown): ManagerView => {
    const normalized = String(value ?? '').trim();
    return normalized === 'catalog' || normalized === 'layout' || normalized === 'operations'
        ? normalized
        : 'overview';
};

const requestedInventoryPages = (query: Request['query']) => Object.fromEntries(
    Object.entries(inventoryQueryNames).map(([key, queryName]) => [
        key,
        normalizeManagementInventoryPage(query[queryName])
    ])
) as Record<InventoryKey, number>;

const inventoryOffsetFor = (pages: Record<InventoryKey, number>, key: InventoryKey) =>
    managementInventoryOffset(pages[key]);

const inventoryLimit = managementInventoryPageSize + 1;

/** Loads one bounded, global page for every shared-content management type. */
const loadGlobalManagementInventory = async (req: Request) => {
    const requestedPages = requestedInventoryPages(req.query);
    const [artistRecords, organizationRecords, albumRecords, audioTrackRecords, pageRecords, carouselRecords, collectionRecords] = await Promise.all([
        Artist.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'artists')),
        Organization.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'organizations')),
        Album.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'albums')),
        AudioTrack.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'audioTracks')),
        Page.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'pages')),
        Carousel.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'carousels')),
        ContentCollection.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'contentCollections'))
    ]);
    const artists = toManagementInventoryPage(artistRecords, requestedPages.artists);
    const organizations = toManagementInventoryPage(organizationRecords, requestedPages.organizations);
    const albums = toManagementInventoryPage(albumRecords, requestedPages.albums);
    const audioTracks = toManagementInventoryPage(audioTrackRecords, requestedPages.audioTracks);
    const pages = toManagementInventoryPage(pageRecords, requestedPages.pages);
    const carousels = toManagementInventoryPage(carouselRecords, requestedPages.carousels);
    const contentCollections = toManagementInventoryPage(collectionRecords, requestedPages.contentCollections);
    const withoutItems = ({ page, hasPrevious, hasNext }: ManagementInventoryPage<unknown>) => ({
        page,
        hasPrevious,
        hasNext
    });

    return {
        catalogArtists: artists.items,
        catalogOrganizations: organizations.items,
        catalogAlbums: albums.items,
        catalogAudioTracks: audioTracks.items,
        catalogPages: pages.items,
        catalogCarousels: carousels.items,
        catalogContentCollections: contentCollections.items,
        inventoryPagination: {
            artists: withoutItems(artists),
            organizations: withoutItems(organizations),
            albums: withoutItems(albums),
            audioTracks: withoutItems(audioTracks),
            pages: withoutItems(pages),
            carousels: withoutItems(carousels),
            contentCollections: withoutItems(contentCollections)
        }
    };
};

const renderInventoryPagination = (
    key: InventoryKey,
    label: string,
    pagination: InventoryPagination
) => {
    const state = pagination[key];
    if (!state.hasPrevious && !state.hasNext) return '';
    const linkFor = (page: number) => {
        const query = new URLSearchParams();
        query.set('view', 'catalog');
        for (const [inventoryKey, queryName] of Object.entries(inventoryQueryNames)) {
            const selectedPage = inventoryKey === key ? page : pagination[inventoryKey as InventoryKey].page;
            if (selectedPage > 1) query.set(queryName, String(selectedPage));
        }
        const serialized = query.toString();
        return `/content/manage${serialized ? `?${serialized}` : ''}#inventory-${key}`;
    };
    const previous = state.hasPrevious
        ? `<a class="button button--secondary" href="${linkFor(state.page - 1)}">Previous ${escapeHtml(label)}</a>`
        : '';
    const next = state.hasNext
        ? `<a class="button button--secondary" href="${linkFor(state.page + 1)}">Next ${escapeHtml(label)}</a>`
        : '';
    return `<nav class="inventory-pagination" aria-label="${escapeHtml(label)} pages">${previous}<span>Page ${state.page}</span>${next}</nav>`;
};


const renderSectionList = (title: string, items: any[], formatter: (item: any) => string) => {
    const content = items.length > 0
        ? items.map((item) => `<li>${formatter(item)}</li>`).join('')
        : '<li>None</li>';

    return `<h3>${title}</h3><ul>${content}</ul>`;
};

const contentId = (item: any) => String(item?._id ?? '');

const renderReferencedItem = (item: any, label: string, prefillType?: string) => {
    const rawId = contentId(item);
    const id = escapeHtml(rawId);
    const editLink = prefillType && id
        ? ` <a href="/content/manage?view=catalog&prefillType=${encodeURIComponent(prefillType)}&prefillId=${encodeURIComponent(rawId)}">Edit</a>`
        : '';
    const copyId = id
        ? ` <button class="copy-id" type="button" data-copy-id="${id}" aria-label="Copy ${escapeHtml(label)} ID">Copy ID</button>`
        : '';

    return `${escapeHtml(label)}${editLink}${copyId}`;
};

const renderMissingReference = (id: string) => {
    return `Not loaded on this inventory page (<code>${escapeHtml(id)}</code>)`;
};

const renderNestedList = (items: string[]) => {
    return items.length > 0
        ? `<ul class="linked-content">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`
        : '<p class="empty-linked-content">None linked</p>';
};

const artistCreditRoleOptions = [
    ['primary', 'Primary'],
    ['featured', 'Featured'],
    ['performer', 'Performer'],
    ['composer', 'Composer'],
    ['producer', 'Producer'],
    ['remixer', 'Remixer']
];
const organizationCreditRoleOptions = [
    ['label', 'Label'],
    ['publisher', 'Publisher'],
    ['distributor', 'Distributor'],
    ['presenter', 'Presenter']
];
const soundtrackParticipantRoleOptions = [
    ['primary', 'Primary Artist'],
    ['featured', 'Featured Artist'],
    ['performer', 'Performer'],
    ['composer', 'Composer'],
    ['producer', 'Producer'],
    ['remixer', 'Remixer']
];

const proposedSoundtrackCredits = (
    audioTrackId: string,
    album: any | null,
    selectedArtistId: string,
    selectedRole: string,
    inheritAlbumPrimary: boolean,
    selectedOrganizationId: string = '',
    selectedOrganizationRole: string = 'label'
) => {
    const inherited = inheritAlbumPrimary && Array.isArray(album?.credits)
        ? album.credits.filter((credit: any) => credit?.subjectType === 'artist'
            && credit?.role === 'primary')
            .map((credit: any) => ({
                creditId: migratedCatalogCreditId(
                    'audioTrack', audioTrackId, 'artist', String(credit.subjectId), 'primary'
                ),
                subjectType: 'artist' as const,
                subjectId: String(credit.subjectId),
                role: 'primary' as const,
                order: 0
            }))
        : [];
    const role = soundtrackParticipantRoleOptions.some(([value]) => value === selectedRole)
        ? selectedRole as 'primary' | 'featured' | 'performer' | 'composer' | 'producer' | 'remixer'
        : 'primary';
    const selected = !selectedArtistId || inherited.some((credit: any) => credit.subjectId === selectedArtistId
        && credit.role === role)
        ? []
        : [{
            creditId: migratedCatalogCreditId(
                'audioTrack', audioTrackId, 'artist', selectedArtistId, role
            ),
            subjectType: 'artist' as const,
            subjectId: selectedArtistId,
            role,
            order: inherited.length
        }];
    const organizationRole = organizationCreditRoleOptions
        .some(([value]) => value === selectedOrganizationRole)
        ? selectedOrganizationRole as 'label' | 'publisher' | 'distributor' | 'presenter'
        : 'label';
    const organizationCredit = selectedOrganizationId
        ? [{
            creditId: migratedCatalogCreditId(
                'audioTrack',
                audioTrackId,
                'organization',
                selectedOrganizationId,
                organizationRole
            ),
            subjectType: 'organization' as const,
            subjectId: selectedOrganizationId,
            role: organizationRole,
            order: inherited.length + selected.length
        }]
        : [];
    return normalizeCatalogCredits([...inherited, ...selected, ...organizationCredit]);
};

const renderCreditRoleOptions = (options: string[][]) => options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');

const renderCreditEditor = (
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    owner: any,
    subjectLabels: Record<string, string>
) => {
    const placementFor = (credit: any) => {
        if (credit.subjectType === 'organization') {
            return ownerType === 'album' ? 'Organization Releases' : 'Soundtrack attribution';
        }
        if (ownerType === 'album' && credit.role === 'primary') return 'Artist Discography';
        if (ownerType === 'album' && credit.role === 'featured') return 'Artist Collaborations';
        if (['composer', 'producer', 'remixer'].includes(String(credit.role))) {
            return 'Artist Credits';
        }
        return ownerType === 'audioTrack'
            ? 'Artist Appears On candidate (Album-level placement takes precedence)'
            : 'Album attribution';
    };
    const credits = Array.isArray(owner?.credits) ? owner.credits : [];
    const creditItems = credits.length > 0
        ? `<ol class="linked-content catalog-credits">${credits.map((credit: any, index: number) => {
            const subjectType = credit.subjectType === 'organization' ? 'organization' : 'artist';
            const subjectId = String(credit.subjectId ?? '');
            const label = subjectLabels[`${subjectType}:${subjectId}`]
                ?? `Unavailable ${subjectType} (${subjectId})`;
            const roleOptions = subjectType === 'organization'
                ? organizationCreditRoleOptions
                : artistCreditRoleOptions;
            const roleSelect = roleOptions.map(([value, roleLabel]) => `<option value="${value}"${credit.role === value ? ' selected' : ''}>${roleLabel}</option>`).join('');
            const hidden = `<input type="hidden" name="ownerType" value="${ownerType}" /><input type="hidden" name="ownerId" value="${escapeHtml(ownerId)}" /><input type="hidden" name="creditId" value="${escapeHtml(String(credit.creditId ?? ''))}" />`;
            return `<li><span><strong>${escapeHtml(label)}</strong> · position ${index + 1}<small class="placement-preview">Public placement: ${escapeHtml(placementFor(credit))}</small></span><form method="POST" action="/content/manage/credits/update-role">${hidden}<label>Role<select name="role">${roleSelect}</select></label><button class="button--secondary" type="submit">Update Role</button></form><form method="POST" action="/content/manage/credits/reorder">${hidden}<button class="button--secondary" name="direction" value="up" type="submit"${index === 0 ? ' disabled' : ''}>Move Up</button><button class="button--secondary" name="direction" value="down" type="submit"${index === credits.length - 1 ? ' disabled' : ''}>Move Down</button></form><form method="POST" action="/content/manage/credits/remove">${hidden}<button class="button--secondary" type="submit">Remove Credit</button></form></li>`;
        }).join('')}</ol>`
        : `<p class="empty-linked-content">${owner?.attributionStatus === 'unknown'
            ? 'Attribution is explicitly not documented.'
            : 'No role-bearing Credits have been recorded yet; legacy relationships remain available during migration.'}</p>`;
    const addForm = (
        subjectType: 'artist' | 'organization',
        roles: string[][]
    ) => `<form method="POST" action="/content/manage/credits/add" data-reference-form>
      <input type="hidden" name="ownerType" value="${ownerType}" />
      <input type="hidden" name="ownerId" value="${escapeHtml(ownerId)}" />
      <input type="hidden" name="subjectType" value="${subjectType}" />
      <div class="reference-picker" data-reference-picker data-reference-type="${subjectType}">
        <label>Find ${subjectType === 'artist' ? 'an Artist' : 'an Organization'}<input type="search" data-reference-query autocomplete="off" /></label>
        <button class="button--secondary" type="button" data-reference-search>Search</button>
        <label>Search results<select name="subjectId" data-reference-results required disabled><option value="">Search first</option></select></label>
        <p class="drag-help" data-reference-status role="status" aria-live="polite"></p>
      </div>
      <label>Credit role<select name="role">${renderCreditRoleOptions(roles)}</select></label>
      ${ownerType === 'audioTrack' && subjectType === 'artist'
        ? '<label><input type="checkbox" name="promoteToAlbumPrimary" value="true" /> If this is a primary Credit, also add the Artist as an Album primary Credit</label><p class="drag-help">Off by default. Featured and performer Credits always stay Soundtrack-only.</p>'
        : ''}
      <button type="submit" data-reference-submit disabled>Add Credit</button>
    </form>`;
    return `<section class="credit-editor"><h3>Credits</h3><p class="muted">Credits control public attribution. A Soundtrack participant is not silently promoted to an Album primary Artist.</p>${creditItems}<details><summary>Add Artist Credit</summary>${addForm('artist', artistCreditRoleOptions)}</details><details><summary>Add Organization Credit</summary>${addForm('organization', organizationCreditRoleOptions)}</details><form method="POST" action="/content/manage/credits/mark-unknown" data-confirm-attribution-unknown><input type="hidden" name="ownerType" value="${ownerType}" /><input type="hidden" name="ownerId" value="${escapeHtml(ownerId)}" /><button class="button--secondary" type="submit">Mark attribution as not documented</button></form></section>`;
};

const renderManagePage = (params: {
    userId: string;
    userEmail: string;
    isAdmin?: boolean;
    message?: string;
    searchQuery?: string;
    selectedUploadTrackId?: string;
    artists?: any[];
    albums?: any[];
    audioTracks?: any[];
    organizations?: any[];
    catalogArtists?: any[];
    catalogOrganizations?: any[];
    catalogAlbums?: any[];
    catalogAudioTracks?: any[];
    catalogPages?: any[];
    catalogCarousels?: any[];
    catalogContentCollections?: any[];
    inventoryPagination?: InventoryPagination;
    s3StorageSummary?: S3StorageSummary | null;
    s3StorageSummaryError?: string;
    prefillArtistId?: string;
    prefillAlbumId?: string;
    prefillAudioTrackId?: string;
    prefillArtist?: any | null;
    prefillArtistAlbums?: any[];
    prefillAlbum?: any | null;
    prefillAudioTrack?: any | null;
    prefillOrganization?: any | null;
    prefillCreditSubjectLabels?: Record<string, string>;
    releaseSetupToken?: string;
    releaseOperations?: ArtistReleaseWorkflowResult[];
    managerView?: ManagerView;
}) => {
    const messageBlock = params.message
        ? `<div class="alert" role="status">${escapeHtml(params.message)}</div>`
        : '';

    const searchQuery = escapeHtml(params.searchQuery ?? '');
    const artists = params.artists ?? [];
    const albums = params.albums ?? [];
    const audioTracks = params.audioTracks ?? [];
    const organizations = params.organizations ?? [];
    const selectedUploadTrackId = escapeHtml(params.selectedUploadTrackId ?? '');

    const catalogArtists = params.catalogArtists ?? [];
    const catalogOrganizations = params.catalogOrganizations ?? [];
    const catalogAlbums = params.catalogAlbums ?? [];
    const catalogAudioTracks = params.catalogAudioTracks ?? [];
    const catalogPages = params.catalogPages ?? [];
    const catalogCarousels = params.catalogCarousels ?? [];
    const catalogContentCollections = params.catalogContentCollections ?? [];
    const prefillCreditSubjectLabels = params.prefillCreditSubjectLabels ?? {};
    const inventoryPagination = params.inventoryPagination;
    const paginationFor = (key: InventoryKey, label: string) => inventoryPagination
        ? renderInventoryPagination(key, label, inventoryPagination)
        : '';
    const s3StorageSummary = params.s3StorageSummary ?? null;
    const s3StorageSummaryError = params.s3StorageSummaryError ?? '';
    const s3StorageBlock = s3StorageSummary
        ? `<div class="storage-summary surface-overview surface-operations"><strong>S3 storage</strong><span>${formatStorageSize(s3StorageSummary.totalBytes)} across ${s3StorageSummary.objectCount} object${s3StorageSummary.objectCount === 1 ? '' : 's'}</span><span>Estimated storage: $${s3StorageSummary.estimatedMonthlyStorageCost.toFixed(2)}/month</span><small>Storage-only estimate at $${s3StorageSummary.storageCostPerGbMonth.toFixed(3)}/GB-month; excludes requests, transfer, and taxes.</small></div>`
        : `<div class="storage-summary surface-overview surface-operations"><strong>S3 storage</strong><span>Usage unavailable${s3StorageSummaryError ? ` (${escapeHtml(s3StorageSummaryError)})` : ''}. Confirm the app has S3 ListBucket permission and that S3_BUCKET_NAME/AWS_REGION match the bucket.</span></div>`;
    const pageOptions = catalogPages.map((page) => {
        const slug = String(page.slug ?? '');
        return `<option value="${escapeHtml(slug)}">${escapeHtml(String(page.title ?? slug))} (${escapeHtml(slug)})</option>`;
    }).join('');
    const carouselOptions = catalogCarousels.map((carousel) => {
        const id = contentId(carousel);
        const dynamicLabel = carousel.mode === 'artist'
            ? ' · Artist'
            : carousel.mode === 'personalized' ? ' · Personalized' : '';
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled carousel'))}${dynamicLabel}</option>`;
    }).join('');
    const manualCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'manual' || !carousel.mode)
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled carousel'))}</option>`;
        }).join('');
    const artistCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'artist')
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled artist carousel'))}</option>`;
        }).join('');
    const personalizedCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'personalized')
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled personalized carousel'))}</option>`;
        }).join('');
    const artistOptions = catalogArtists.map((artist) => {
        const id = contentId(artist);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(artist.name ?? 'Untitled artist'))}</option>`;
    }).join('');
    const organizationOptions = catalogOrganizations.map((organization) => {
        const id = contentId(organization);
        const type = String(organization.organizationType ?? 'organization');
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(organization.name ?? 'Untitled organization'))} · ${escapeHtml(type)}</option>`;
    }).join('');
    const albumOptions = catalogAlbums.map((album) => {
        const id = contentId(album);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(album.title ?? 'Untitled album'))}</option>`;
    }).join('');
    const compositionData = JSON.stringify({
        pages: catalogPages.map((page) => ({
            slug: String(page.slug ?? ''),
            title: String(page.title ?? page.slug ?? ''),
            items: Array.isArray(page.items) ? page.items.map((item: any) => ({
                itemType: String(item.itemType ?? (item.carouselId ? 'carousel' : 'unknown')),
                carouselId: String(item.carouselId ?? ''),
                collectionId: String(item.collectionId ?? ''),
                order: Number(item.order ?? 0)
            })) : []
        })),
        carousels: catalogCarousels.map((carousel) => ({
            id: contentId(carousel),
            name: String(carousel.name ?? 'Untitled carousel'),
            mode: carousel.mode === 'artist' ? 'artist' : carousel.mode === 'personalized' ? 'personalized' : 'manual',
            artistConfig: carousel.artistConfig ?? null,
            personalizedConfig: carousel.personalizedConfig ?? null,
            items: Array.isArray(carousel.items) ? carousel.items.map((item: any) => ({ contentId: String(item.contentId ?? ''), contentType: String(item.contentType ?? 'Content'), order: Number(item.order ?? 0) })) : []
        })),
        contentCollections: catalogContentCollections.map((collection) => ({
            id: contentId(collection),
            name: String(collection.name ?? 'Untitled collection'),
            presentation: String(collection.presentation ?? ''),
            mode: String(collection.mode ?? 'manual'),
            dynamicSource: collection.dynamicSource ? String(collection.dynamicSource) : null
        })),
        albums: catalogAlbums.map((album) => ({ id: contentId(album), title: String(album.title ?? '') })),
        audioTracks: catalogAudioTracks.map((track) => ({ id: contentId(track), title: String(track.title ?? '') }))
    }).replace(/</g, '\\u003c');
    const prefillArtistId = escapeHtml(params.prefillArtistId ?? '');
    const prefillAlbumId = escapeHtml(params.prefillAlbumId ?? '');
    const prefillAudioTrackId = escapeHtml(params.prefillAudioTrackId ?? '');
    const prefillArtist = params.prefillArtist ?? null;
    const prefillArtistAlbums = params.prefillArtistAlbums ?? [];
    const prefillAlbum = params.prefillAlbum ?? null;
    const prefillAudioTrack = params.prefillAudioTrack ?? null;
    const prefillOrganization = params.prefillOrganization ?? null;
    const prefillOrganizationId = contentId(prefillOrganization);
    const organizationUpdateTarget = prefillOrganizationId
        ? `<input type="hidden" name="organizationId" value="${escapeHtml(prefillOrganizationId)}" /><p class="muted">Editing <strong>${escapeHtml(String(prefillOrganization.name ?? 'Organization'))}</strong>. <a href="/content/manage?view=catalog#organization-workspace">Choose another</a></p>`
        : `<div class="reference-picker" data-reference-picker data-reference-type="organization">
            <label>Find Organization<input type="search" data-reference-query autocomplete="off" /></label>
            <button class="button--secondary" type="button" data-reference-search>Search</button>
            <label>Search results<select name="organizationId" data-reference-results required disabled><option value="">Search first</option></select></label>
            <p class="drag-help" data-reference-status role="status" aria-live="polite"></p>
          </div>`;
    const organizationTypeOptions = organizationTypes.map((type) => `<option value="${type}"${String(prefillOrganization?.organizationType ?? '') === type ? ' selected' : ''}>${type}</option>`).join('');
    const releaseSetupToken = escapeHtml(params.releaseSetupToken ?? '');
    const releaseOperations = params.releaseOperations ?? [];
    const managerView = params.managerView ?? 'overview';
    const selectedType = prefillArtist
        ? 'artist'
        : prefillAlbum
            ? 'album'
            : prefillAudioTrack
                ? 'audioTrack'
                : prefillOrganization ? 'organization' : 'none';
    const selectedId = prefillArtistId || prefillAlbumId || prefillAudioTrackId || prefillOrganizationId;
    const selectedLabel = prefillArtist
        ? String(prefillArtist.name ?? 'Artist')
        : prefillAlbum
            ? String(prefillAlbum.title ?? 'Album')
            : prefillAudioTrack
                ? String(prefillAudioTrack.title ?? 'Soundtrack')
                : prefillOrganization ? String(prefillOrganization.name ?? 'Organization') : '';
    const selectedTypeLabel = selectedType === 'audioTrack'
        ? 'Soundtrack'
        : selectedType === 'none' ? '' : `${selectedType[0].toUpperCase()}${selectedType.slice(1)}`;
    const selectedObjectBlock = selectedType === 'none'
        ? ''
        : `<section class="card selected-object surface-catalog" id="selected-object" aria-labelledby="selected-object-title"><div><p class="eyebrow">Selected ${escapeHtml(selectedTypeLabel)}</p><h2 id="selected-object-title">${escapeHtml(selectedLabel)}</h2><p class="muted">Edit this object below. Inventory filters and pagination remain available when you return to the list.</p></div><div class="action-row"><button class="button button--secondary" type="button" data-copy-id="${escapeHtml(selectedId)}">Copy ID</button><a class="button button--secondary" href="/content/manage?view=catalog#catalog-content">Back to inventory</a></div></section>`;
    const bulkAudioUploadBlock = `<details class="advanced-tools" id="bulk-audio-upload"><summary>Bulk upload Soundtracks</summary><p>Select up to 20 files. A Soundtrack is created for each file using embedded metadata when available.</p><form id="bulk-audio-upload-form" method="POST" action="/content/manage/audioTrack/bulk-upload" enctype="multipart/form-data"><select name="artistId"><option value="">No Artist Credit</option>${artistOptions}</select><select name="artistRole">${renderCreditRoleOptions(soundtrackParticipantRoleOptions)}</select><select name="organizationId"><option value="">No Organization Credit</option>${organizationOptions}</select><select name="organizationRole">${renderCreditRoleOptions(organizationCreditRoleOptions)}</select><select name="albumId"><option value="">No album</option>${albumOptions}</select><label><input type="checkbox" name="inheritAlbumPrimaryCredits" value="true" checked /> Inherit the selected Album's primary Artists</label><label><input type="checkbox" name="attributionUnknown" value="true" /> Attribution is not documented</label><label><input type="checkbox" name="promoteToAlbumPrimary" value="true" /> If this participant is primary, also add them to the Album</label><input type="file" name="audioFiles" accept="audio/*" multiple required /><button type="submit">Create and Upload Audio Files</button><div id="bulk-upload-status" role="status" aria-live="polite" hidden><progress id="bulk-upload-progress" max="100" value="0">0%</progress><span id="bulk-upload-progress-label">0%</span></div></form></details>`;
    const releaseOperationsBlock = renderReleaseOperations(releaseOperations);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Content Manager</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .content-hierarchy { display: grid; gap: 16px; }
    .hierarchy-item { border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    .hierarchy-item:last-child { border-bottom: 0; padding-bottom: 0; }
    .hierarchy-item > strong { display: block; }
    .linked-content { margin: 6px 0 0 18px; padding-left: 18px; }
    .page-item-list { display: grid; gap: 8px; margin-top: 10px; }
    .page-item-list > li { padding-left: 4px; }
    .page-item-list .item-meta { display: inline-flex; margin-left: 6px; }
    .track-selection { align-items: center; display: flex; gap: 8px; margin: 6px 0 0 18px; padding-left: 18px; }
    .track-selection input { margin: 0; }
    .batch-track-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .empty-linked-content { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
    .drag-list { display: grid; gap: 6px; margin: 10px 0; padding: 0; list-style: none; }
    .drag-item { background: var(--surface-strong); border: 1px solid var(--line); border-radius: 8px; cursor: grab; padding: 10px; }
    .drag-item.dragging { opacity: .45; }
    .drag-item.drag-over { border-color: var(--brand); }
    .drag-help { color: var(--muted); font-size: 13px; margin: 6px 0; }
    .move-item-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .move-item-choice { align-items: center; display: flex; gap: 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-strong); padding: 9px 10px; }
    .move-item-choice input { flex: 0 0 auto; margin: 0; }
    .manager-nav { display: flex; gap: 8px; margin: 18px 0 24px; overflow-x: auto; padding-bottom: 4px; }
    .manager-nav a { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); padding: 7px 12px; font-size: 13px; font-weight: 700; text-decoration: none; }
    .manager-nav a[aria-current="page"] { background: var(--brand); color: white; }
    .copy-id { min-height: 28px; border-color: var(--line); color: var(--muted); background: transparent; padding: 4px 8px; font-size: 12px; vertical-align: middle; }
    .copy-id:hover { color: var(--ink); background: var(--surface-strong); transform: none; box-shadow: none; }
    .selected-object { align-items: center; display: flex; justify-content: space-between; gap: 18px; border-color: #badcc9; background: var(--success-soft); }
    .selected-object h2 { margin-bottom: 6px; }
    .selected-object p:last-child { margin-bottom: 0; }
    .object-workspaces { grid-template-columns: 1fr; }
    .workspace-context { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; padding: 12px; border-radius: 10px; background: var(--surface-strong); }
    .workspace-context p { margin: 0; }
    .workspace-section { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 20px; }
    .danger-zone { border-color: #efc0ba; background: var(--danger-soft); }
    body.manager-view-catalog:not(.manager-selection-none) .page-shell { display: flex; flex-direction: column; }
    body.manager-view-catalog:not(.manager-selection-none) .site-header { order: 0; }
    body.manager-view-catalog:not(.manager-selection-none) .manager-nav { order: 1; }
    body.manager-view-catalog:not(.manager-selection-none) #search { order: 2; }
    body.manager-view-catalog:not(.manager-selection-none) #selected-object { order: 3; margin-top: 18px; }
    body.manager-view-catalog:not(.manager-selection-none) #update-delete { order: 4; }
    body.manager-view-catalog:not(.manager-selection-none) #catalog-object-workspaces { order: 5; }
    body.manager-view-catalog:not(.manager-selection-none) #create { order: 6; }
    body.manager-view-catalog:not(.manager-selection-none) #catalog-create-tools { order: 7; }
    body.manager-view-catalog:not(.manager-selection-none) #catalog-content { order: 8; }
    body.manager-view-catalog:not(.manager-selection-none) #catalog-inventory { order: 9; }
    body.manager-view-catalog:not(.manager-selection-none) #quick-linking { order: 10; }
    body.manager-view-catalog:not(.manager-selection-none) #catalog-quick-linking-tools { order: 11; }
    body.manager-selection-artist #album-update-card,
    body.manager-selection-artist #audio-track-update-card,
    body.manager-selection-album #artist-update-card,
    body.manager-selection-album #audio-track-update-card,
    body.manager-selection-audioTrack #artist-update-card,
    body.manager-selection-audioTrack #album-update-card { display: none; }
    body.manager-selection-organization #update-delete,
    body.manager-selection-organization #catalog-object-workspaces { display: none; }
    body.manager-selection-organization #catalog-create-tools > :not(#organization-workspace) { display: none; }
    body.manager-selection-artist #create,
    body.manager-selection-artist #catalog-create-tools,
    body.manager-selection-album #create,
    body.manager-selection-album #catalog-create-tools,
    body.manager-selection-audioTrack #create,
    body.manager-selection-audioTrack #catalog-create-tools { display: none; }
    body:not(.manager-view-overview) .surface-overview,
    body:not(.manager-view-catalog) .surface-catalog,
    body:not(.manager-view-layout) .surface-layout,
    body:not(.manager-view-operations) .surface-operations { display: none !important; }
    body.manager-view-overview .surface-overview.surface-operations,
    body.manager-view-operations .surface-overview.surface-operations { display: block !important; }
    body.manager-view-overview .storage-summary.surface-overview.surface-operations,
    body.manager-view-operations .storage-summary.surface-overview.surface-operations { display: grid !important; }
    .inventory-pagination { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 16px; }
    .inventory-pagination span { color: var(--muted); font-size: 14px; font-weight: 700; }
    .artist-album-memberships { display: grid; gap: 8px; margin: 12px 0; padding: 0; list-style: none; }
    .artist-album-memberships > li { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; }
    .artist-album-memberships form { margin: 0; }
    .reference-picker { display: grid; gap: 8px; }
    details.advanced-tools { margin-top: 16px; }
    details.advanced-tools summary { cursor: pointer; font-weight: 700; }
    .release-setup form { display: grid; gap: 16px; }
    .release-setup fieldset { border: 1px solid var(--line); border-radius: 10px; display: grid; gap: 10px; margin: 0; padding: 16px; }
    .release-setup legend { font-weight: 800; padding: 0 6px; }
    .release-review { background: var(--surface-strong); border-radius: 10px; padding: 14px; }
    .operation-list { display: grid; gap: 14px; list-style: none; margin: 0; padding: 0; }
    .operation-card { border: 1px solid var(--line); border-radius: 10px; display: grid; gap: 12px; padding: 14px; }
    .operation-heading, .operation-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; }
    .operation-actions form { margin: 0; }
    .operation-steps { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
    .operation-step { align-items: start; display: flex; gap: 9px; }
    .operation-step > span:first-child { align-items: center; background: var(--surface-strong); border-radius: 50%; display: inline-flex; flex: 0 0 24px; height: 24px; justify-content: center; }
    .operation-step small { color: var(--muted); display: block; }
    .layout-workspace { display: grid; gap: 18px; }
    .layout-tools { display: grid; gap: 14px; }
    .tool-group { padding: 0; overflow: hidden; }
    .tool-group > summary { cursor: pointer; font-size: 18px; font-weight: 800; padding: 20px; }
    .tool-group > summary:hover { background: var(--surface-strong); }
    .tool-group__body { border-top: 1px solid var(--line); padding: 4px 20px 20px; }
    .layout-current .content-hierarchy { margin-top: 14px; }
    .drag-item { align-items: center; display: flex; justify-content: space-between; gap: 10px; }
    .drag-item__label { flex: 1; }
    .drag-item__actions { display: flex; gap: 6px; }
    .drag-item__actions button { min-height: 32px; padding: 5px 9px; }
    .card h3:not(:first-child) { margin-top: 24px; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
  </style>
</head>
<body class="manager-view-${managerView} manager-selection-${selectedType}">
  <main class="page-shell">
  <header class="site-header">
    <div>
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">A</span><span>Archtree</span></a>
      <p class="eyebrow" style="margin-top:18px;">Catalog workspace</p>
      <h1 style="margin-bottom:8px;">Content Manager</h1>
      <p class="muted">Signed in as <strong>${escapeHtml(params.userEmail)}</strong></p>
    </div>
    <div class="header-actions">
      <a class="button" href="/content/manage/audio-tracks">Audio Tracks</a>
      ${params.isAdmin ? '<a class="button button--secondary" href="/admin/audio-storage/reconciliation">Audit Audio Storage</a><a class="button button--secondary" href="/admin/image-storage/reconciliation">Audit Image Storage</a>' : ''}
      <a class="button button--secondary" href="/">Home</a>
      <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(params.userId)}" /><button class="button--secondary" type="submit">Log out</button></form>
    </div>
  </header>
  ${messageBlock}
  <section class="card upload-results surface-operations" id="bulk-upload-results" role="status" aria-live="polite" hidden>
    <h2>Upload results</h2>
    <div class="upload-results__grid"></div>
  </section>
  ${s3StorageBlock}
  <nav class="manager-nav" aria-label="Content Manager sections">
    <a href="/content/manage?view=overview"${managerView === 'overview' ? ' aria-current="page"' : ''}>Overview</a>
    <a href="/content/manage?view=catalog"${managerView === 'catalog' ? ' aria-current="page"' : ''}>Catalog</a>
    <a href="/content/manage?view=layout"${managerView === 'layout' ? ' aria-current="page"' : ''}>Page Layout</a>
    <a href="/content/manage?view=operations"${managerView === 'operations' ? ' aria-current="page"' : ''}>Operations</a>
  </nav>

  <section class="card release-setup surface-overview" id="artist-release-setup">
    <p class="eyebrow">Guided workflow</p>
    <h2>Set up an Artist release</h2>
    <p>Create or reuse an Artist, create and link its Album, then optionally create an Album carousel and place it on a Page. Review all selections before submitting.</p>
    <form method="POST" action="/content/manage/workflows/artist-release" enctype="multipart/form-data" data-release-setup>
      <input type="hidden" name="idempotencyToken" value="${releaseSetupToken}" />
      <fieldset>
        <legend>1. Artist</legend>
        <label>Artist choice<select name="artistMode" data-artist-mode><option value="existing">Use an existing Artist</option><option value="new">Create a new Artist</option></select></label>
        <div data-existing-artist>
          <div class="reference-picker" data-reference-picker data-reference-type="artist">
            <label>Find an Artist<input type="search" data-reference-query placeholder="Search by Artist name" autocomplete="off" /></label>
            <button class="button--secondary" type="button" data-reference-search>Search Artists</button>
            <label>Search results<select name="existingArtistId" data-reference-results disabled><option value="">Search for an Artist first</option></select></label>
            <p class="drag-help" data-reference-status role="status" aria-live="polite"></p>
          </div>
        </div>
        <div class="stack" data-new-artist hidden>
          <label>Artist name<input name="artistName" /></label>
          <label>Biography<textarea name="artistBio" rows="3"></textarea></label>
          <label>Birth date<input name="artistBirthDate" type="date" /></label>
          <label>Artist cover art (optional)<input name="artistCoverArtFile" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>2. Album</legend>
        <label>Album title<input name="albumTitle" required /></label>
        <label>Release date<input name="albumReleaseDate" type="date" /></label>
        <label>Album cover art (optional)<input name="albumCoverArtFile" type="file" accept="image/jpeg,image/png,image/webp" /></label>
      </fieldset>
      <fieldset>
        <legend>3. Presentation (optional)</legend>
        <label><input type="checkbox" name="createCarousel" value="true" data-create-carousel /> Create a dynamic Album Artist Carousel</label>
        <div class="stack" data-carousel-config hidden>
          <label>Carousel name<input name="carouselName" placeholder="Defaults from the Artist" /></label>
          <label>Sort<select name="carouselSort"><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A–Z</option></select></label>
          <label>Item limit<input name="carouselLimit" type="number" min="1" max="100" value="20" /></label>
          <label>Page placement<select name="pageSlug"><option value="">Do not attach to a Page</option><option value="home">Home</option><option value="library">Library</option></select></label>
          <label>Position (optional, 0-based)<input name="pagePosition" type="number" min="0" /></label>
        </div>
      </fieldset>
      <section class="release-review" aria-live="polite">
        <h3>4. Review</h3>
        <p data-release-review>Choose an Artist and enter an Album title.</p>
      </section>
      <button type="submit">Create Artist Release</button>
    </form>
  </section>

  <section class="card surface-overview surface-operations" id="workflow-operations">
    <p class="eyebrow">Operations</p><h2>Recent Artist release setups</h2>
    <p class="muted">Each setup is resumable. Completed steps are preserved when an incomplete operation is retried.</p>
    ${releaseOperationsBlock}
  </section>

  <div class="card surface-catalog" id="search">
    <h2>Unified Search</h2>
    <form method="GET" action="/content/manage/search">
      <input type="text" name="q" value="${searchQuery}" placeholder="Search artist, organization, album, track" required />
      <button type="submit">Search</button>
    </form>
    ${renderSectionList('Artists', artists, (item) => renderReferencedItem(item, String(item.name ?? ''), 'artist'))}
    ${renderSectionList('Organizations', organizations, (item) => renderReferencedItem(item, String(item.name ?? ''), 'organization'))}
    ${renderSectionList('Albums', albums, (item) => renderReferencedItem(item, String(item.title ?? ''), 'album'))}
    ${renderSectionList('Audio Tracks', audioTracks, (item) => renderReferencedItem(item, String(item.title ?? ''), 'audioTrack'))}
  </div>
  ${selectedObjectBlock}

  <div class="section-heading surface-catalog" id="catalog-content"><div><p class="eyebrow">Global inventory</p><h2>Catalog Content</h2></div></div>
  <div class="card surface-catalog" id="catalog-inventory">
    <section id="inventory-artists">
    <h3>Artists</h3>
    <div class="content-hierarchy">
      ${catalogArtists.length > 0 ? catalogArtists.map((artist) => {
          const linkedAlbumIds = uniqueStrings(Array.isArray(artist.albumIds) ? artist.albumIds.map(String) : []);
          const albumsById = new Map(catalogAlbums.map((album) => [contentId(album), album]));
          const linkedAlbums = linkedAlbumIds.map((albumId) => {
              const album = albumsById.get(albumId);
              if (!album) return renderMissingReference(albumId);

              return renderReferencedItem(album, String(album.title ?? ''), 'album');
          });

          return `<div class="hierarchy-item"><strong>${renderReferencedItem(artist, String(artist.name ?? ''), 'artist')}</strong><span>${linkedAlbumIds.length} linked album${linkedAlbumIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedAlbums)}</div>`;
      }).join('') : '<p class="empty-linked-content">No artists yet.</p>'}
    </div>
    ${paginationFor('artists', 'Artists')}
    </section>

    <section id="inventory-organizations">
      <h3>Organizations</h3>
      <div class="content-hierarchy">
        ${catalogOrganizations.length > 0 ? catalogOrganizations.map((organization) => {
            const organizationId = contentId(organization);
            const creditedAlbums = catalogAlbums.filter((album) => (Array.isArray(album.credits) ? album.credits : [])
                .some((credit: any) => credit?.subjectType === 'organization' && String(credit.subjectId ?? '') === organizationId));
            return `<div class="hierarchy-item"><strong>${renderReferencedItem(organization, String(organization.name ?? ''), 'organization')}</strong><span>${escapeHtml(String(organization.organizationType ?? 'other'))} · ${creditedAlbums.length} release${creditedAlbums.length === 1 ? '' : 's'} on this page</span>${renderNestedList(creditedAlbums.map((album) => renderReferencedItem(album, String(album.title ?? ''), 'album')))}</div>`;
        }).join('') : '<p class="empty-linked-content">No organizations yet.</p>'}
      </div>
      ${paginationFor('organizations', 'Organizations')}
    </section>

    <section id="inventory-albums">
    <h3>Albums</h3>
    <div class="content-hierarchy">
      ${catalogAlbums.length > 0 ? catalogAlbums.map((album) => {
          const albumId = contentId(album);
          const linkedTrackIds = uniqueStrings([
              ...(Array.isArray(album.audioTrackIds) ? album.audioTrackIds.map(String) : []),
              ...catalogAudioTracks.filter((track) => String(track.albumId ?? '') === albumId).map(contentId)
          ]);
          const tracksById = new Map(catalogAudioTracks.map((track) => [contentId(track), track]));
          const linkedTracks = linkedTrackIds.map((trackId) => {
              const track = tracksById.get(trackId);
              if (!track) return renderMissingReference(trackId);

              return `<label class="track-selection"><input type="checkbox" name="audioTrackIds" value="${escapeHtml(trackId)}" aria-label="Select ${escapeHtml(String(track.title ?? 'audio track'))}" />${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</label>`;
          });
          const selectableTrackCount = linkedTrackIds.filter((trackId) => tracksById.has(trackId)).length;

          return `<form class="hierarchy-item" data-batch-track-delete method="POST" action="/content/manage/album/delete-audio-tracks"><input type="hidden" name="albumId" value="${escapeHtml(albumId)}" /><strong>${renderReferencedItem(album, String(album.title ?? ''), 'album')}</strong><span>${linkedTrackIds.length} linked track${linkedTrackIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedTracks)}${selectableTrackCount > 0 ? '<div class="batch-track-actions"><button class="select-all-tracks button--secondary" type="button">Select all</button><button class="batch-delete-button" data-danger type="submit" disabled>Delete selected tracks</button></div>' : ''}</form>`;
      }).join('') : '<p class="empty-linked-content">No albums yet.</p>'}
    </div>
    ${paginationFor('albums', 'Albums')}
    </section>

        <section id="inventory-audioTracks">
          <h3>Audio Tracks</h3>
          <div class="content-hierarchy">
            ${catalogAudioTracks.length > 0 ? catalogAudioTracks.map((track) => `<div class="hierarchy-item"><strong>${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</strong><span>${escapeHtml(String(track.uploadStatus ?? 'legacy'))}</span></div>`).join('') : '<p class="empty-linked-content">No audio tracks yet.</p>'}
          </div>
          ${paginationFor('audioTracks', 'Audio Tracks')}
        </section>

        <section id="inventory-pages">
          ${renderPageItemsHierarchy(catalogPages, catalogCarousels, catalogContentCollections)}
          ${paginationFor('pages', 'Pages')}
        </section>

        <section id="inventory-carousels">
        <h3>Carousels</h3>
        <div class="content-hierarchy">
          ${catalogCarousels.length > 0 ? catalogCarousels.map((carousel) => {
              const items = Array.isArray(carousel.items) ? [...carousel.items].sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0)) : [];
              const isArtistCarousel = carousel.mode === 'artist';
              const isPersonalizedCarousel = carousel.mode === 'personalized';
              const artistName = isArtistCarousel
                  ? String(catalogArtists.find((artist) => contentId(artist) === String(carousel.artistConfig?.artistId ?? ''))?.name ?? 'Artist not loaded on this inventory page')
                  : '';
              const albumsById = new Map(catalogAlbums.map((album) => [contentId(album), album]));
              const tracksById = new Map(catalogAudioTracks.map((track) => [contentId(track), track]));
              const carouselItems = items.map((item: any) => {
                  const itemId = String(item.contentId ?? '');
                  if (item.contentType === 'album' && albumsById.has(itemId)) {
                      return `Album: ${renderReferencedItem(albumsById.get(itemId), String(albumsById.get(itemId).title ?? ''), 'album')}`;
                  }
                  if (item.contentType === 'audioTrack' && tracksById.has(itemId)) {
                      return `Track: ${renderReferencedItem(tracksById.get(itemId), String(tracksById.get(itemId).title ?? ''), 'audioTrack')}`;
                  }
                  return `${escapeHtml(String(item.contentType ?? 'Content'))}: ${renderMissingReference(itemId)}`;
              });

              const dynamicSummary = isArtistCarousel
                  ? `<span class="pill">Dynamic</span> <span>${escapeHtml(artistName)} · ${carousel.artistConfig?.contentType === 'album' ? 'Albums' : 'Audio tracks'}</span>`
                  : isPersonalizedCarousel
                      ? `<span class="pill">Personalized</span> <span>${carousel.personalizedConfig?.source === 'recentlyPlayed' ? 'Recently Played' : 'Recently Saved'} · Mixed content</span>`
                  : '<span class="pill pill--muted">Manual</span>';
              return `<div class="hierarchy-item"><strong>${renderReferencedItem(carousel, String(carousel.name ?? ''))}</strong><div class="item-meta">${dynamicSummary}<span>${items.length} item${items.length === 1 ? '' : 's'}</span></div>${renderNestedList(carouselItems)}</div>`;
          }).join('') : '<p class="empty-linked-content">No carousels yet.</p>'}
        </div>
        ${paginationFor('carousels', 'Carousels')}
        </section>

        <section id="inventory-contentCollections">
          <h3>Content Collections</h3>
          <div class="content-hierarchy">
            ${catalogContentCollections.length > 0 ? catalogContentCollections.map((collection) => {
                const presentation = String(collection.presentation ?? 'collection');
                const mode = collection.mode === 'dynamic' ? 'Dynamic' : 'Manual';
                return `<div class="hierarchy-item"><strong>${renderReferencedItem(collection, String(collection.name ?? 'Untitled collection'))}</strong><span>${escapeHtml(presentation)} · ${mode}</span></div>`;
            }).join('') : '<p class="empty-linked-content">No content collections yet.</p>'}
          </div>
          ${paginationFor('contentCollections', 'Content Collections')}
        </section>
  </div>

    <div class="section-heading surface-layout" id="composition"><div><p class="eyebrow">Presentation</p><h2>Page Layout</h2></div></div>
    <div class="layout-workspace surface-layout">
      <section class="card layout-current" aria-labelledby="current-page-layout-heading">
        <p class="eyebrow">Current structure</p>
        <h2 id="current-page-layout-heading">Pages and placed content</h2>
        <p class="muted">Review the published structure first. Open a tool below only when you need to make a change.</p>
        ${renderPageItemsHierarchy(catalogPages, catalogCarousels, catalogContentCollections)}
      </section>
      <div class="layout-tools">
        <details class="card tool-group" open>
          <summary>Page settings and placement</summary>
          <div class="tool-group__body">
            <h3>Save Page (Home/Library)</h3>
            <form method="POST" action="/content/manage/composition/page/save">
                <input name="slug" placeholder="Slug: home or library" required />
                <input name="title" placeholder="Page title" required />
                <button type="submit">Save Page</button>
            </form>

            <h3>Attach Carousel to Page</h3>
            <form method="POST" action="/content/manage/composition/page/attach-carousel">
                <select name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <select name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <input name="position" placeholder="Position (optional, 0-based)" />
                <button type="submit">Attach Carousel</button>
            </form>

            <h3>Reorder Page Item</h3>
            <form class="drag-reorder" data-kind="page" method="POST" action="/content/manage/composition/page/reorder-item">
                <select class="reorder-selector" name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <p class="drag-help">Drag a carousel to its new position, then save.</p>
                <ul class="drag-list" aria-label="Page item order"></ul>
                <input class="from-index" type="hidden" name="fromIndex" />
                <input class="to-index" type="hidden" name="toIndex" />
                <button class="save-reorder" type="submit" disabled>Save New Order</button>
            </form>

            <h3>Detach Carousel from Page</h3>
            <form method="POST" action="/content/manage/composition/page/detach-carousel">
                <select name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <select name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <button type="submit">Detach Carousel</button>
            </form>
          </div>
        </details>

        <details class="card tool-group">
          <summary>Create and configure Carousels</summary>
          <div class="tool-group__body">
            <h3>Create Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/create">
                <input name="name" placeholder="Carousel name" required />
                <select class="carousel-mode" name="mode" required><option value="manual">Manual carousel</option><option value="artist">Artist carousel</option><option value="personalized">Personalized carousel</option></select>
                <div class="artist-carousel-config stack" hidden>
                    <select name="artistId"><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                    <select name="artistContentType"><option value="album">Albums</option><option value="audioTrack">Audio tracks</option></select>
                    <select name="artistScope"><option value="discography">Discography / primary</option><option value="collaborations">Collaborations / featured</option><option value="appearsOn">Appears On / performer</option><option value="allRelated">All related credits</option></select>
                    <select name="artistSort"><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A–Z</option></select>
                    <input name="artistLimit" type="number" min="1" max="100" value="20" />
                    <p class="drag-help">Items are generated automatically from the selected artist and cannot be manually reordered.</p>
                </div>
                <div class="personalized-carousel-config stack" hidden>
                    <select name="personalizedSource"><option value="recentlySaved">Recently Saved</option><option value="recentlyPlayed">Recently Played</option></select>
                    <input name="personalizedLimit" type="number" min="1" max="20" value="20" />
                    <p class="drag-help">Albums and audio tracks are mixed automatically for the signed-in viewer.</p>
                </div>
                <button type="submit">Create Carousel</button>
            </form>

            <h3>Update Artist Carousel</h3>
            <form class="update-artist-carousel" method="POST" action="/content/manage/composition/carousel/update-artist">
                <select class="artist-carousel-selector" name="carouselId" required><option value="" disabled selected>Select artist carousel</option>${artistCarouselOptions}</select>
                <input name="name" placeholder="Carousel name" required />
                <select name="artistId" required><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                <select name="artistContentType" required><option value="album">Albums</option><option value="audioTrack">Audio tracks</option></select>
                <select name="artistScope" required><option value="discography">Discography / primary</option><option value="collaborations">Collaborations / featured</option><option value="appearsOn">Appears On / performer</option><option value="allRelated">All related credits</option></select>
                <select name="artistSort" required><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A–Z</option></select>
                <input name="artistLimit" type="number" min="1" max="100" value="20" required />
                <button type="submit">Update Artist Carousel</button>
            </form>

            <h3>Update Personalized Carousel</h3>
            <form class="update-personalized-carousel" method="POST" action="/content/manage/composition/carousel/update-personalized">
                <select class="personalized-carousel-selector" name="carouselId" required><option value="" disabled selected>Select personalized carousel</option>${personalizedCarouselOptions}</select>
                <input name="name" placeholder="Carousel name" required />
                <select name="personalizedSource" required><option value="recentlySaved">Recently Saved</option><option value="recentlyPlayed">Recently Played</option></select>
                <input name="personalizedLimit" type="number" min="1" max="20" value="20" required />
                <button type="submit">Update Personalized Carousel</button>
            </form>

            <h3>Rename Manual Carousel</h3>
            <form class="rename-manual-carousel" method="POST" action="/content/manage/composition/carousel/rename-manual">
                <select class="manual-carousel-selector" name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
                <input name="name" placeholder="New carousel name" required />
                <button type="submit">Rename Carousel</button>
            </form>

            <h3>Add Item to Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/add-item">
                <select name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
                <select name="contentType" required><option value="" disabled selected>Select content type</option><option value="post">Post</option><option value="album">Album</option><option value="audioTrack">Audio Track</option></select>
                <input name="contentId" placeholder="Content ID" required />
                <button type="submit">Add Carousel Item</button>
            </form>

            <h3>Reorder Carousel Item</h3>
            <form class="drag-reorder" data-kind="carousel" method="POST" action="/content/manage/composition/carousel/reorder-item">
                <select class="reorder-selector" name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
                <p class="drag-help">Drag an item to its new position, then save.</p>
                <ul class="drag-list" aria-label="Carousel item order"></ul>
                <input class="from-index" type="hidden" name="fromIndex" />
                <input class="to-index" type="hidden" name="toIndex" />
                <button class="save-reorder" type="submit" disabled>Save New Order</button>
            </form>
          </div>
        </details>

        <details class="card tool-group">
          <summary>Move or delete manual Carousel items</summary>
          <div class="tool-group__body">
            <h3>Move Items Between Carousels</h3>
            <form class="move-carousel-items" method="POST" action="/content/manage/composition/carousel/move-item">
                <select class="move-source-carousel" name="sourceCarouselId" required><option value="" disabled selected>Select source carousel</option>${manualCarouselOptions}</select>
                <p class="drag-help">Load the source through Carousel pagination, then select the items to move. They keep their order and are added to the destination.</p>
                <ul class="move-item-list" aria-live="polite"><li class="empty-linked-content">Choose a source carousel to see its items.</li></ul>
                <input class="move-target-carousel" name="targetCarouselId" list="move-target-carousel-options" placeholder="Destination carousel ID" required />
                <datalist id="move-target-carousel-options">${manualCarouselOptions}</datalist>
                <button class="move-selected-items" type="submit" disabled>Move Selected Items</button>
            </form>

            <h3>Delete Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/delete">
                <input name="carouselId" placeholder="Carousel ID" required />
                <button data-danger type="submit">Delete Carousel</button>
            </form>
            <p>Deleting a carousel will automatically detach it from all pages.</p>
          </div>
        </details>
      </div>
    </div>

    <div id="composition-data" class="surface-layout" hidden>${escapeHtml(compositionData)}</div>

  <div class="section-heading surface-catalog" id="create"><div><p class="eyebrow">${prefillOrganization ? 'Selected object' : 'New records'}</p><h2>${prefillOrganization ? 'Organization workspace' : 'Create'}</h2></div></div>
  <div class="grid surface-catalog" id="catalog-create-tools">
    <div class="card create-card">
      <h3>Create Artist</h3>
      <form method="POST" action="/content/manage/artist/create" enctype="multipart/form-data">
        <input name="name" placeholder="Name" required />
        <input name="birthDate" type="date" />
        <input name="bio" placeholder="Bio" />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
        <input name="albumIds" placeholder="Album IDs (comma separated)" />
        <button type="submit">Create Artist</button>
      </form>
    </div>

    <div class="card create-card">
      <h3>Create Album</h3>
      <form method="POST" action="/content/manage/album/create" enctype="multipart/form-data">
        <input name="title" placeholder="Title" required />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <input name="releaseDate" type="date" />
        <button type="submit">Create Album</button>
      </form>
    </div>

    <div class="card create-card">
      <h3>Create and Upload Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/create" enctype="multipart/form-data">
        <input name="title" placeholder="Title" required />
        <select name="artistId"><option value="">No Artist Credit</option>${artistOptions}</select>
        <select name="artistRole">${renderCreditRoleOptions(soundtrackParticipantRoleOptions)}</select>
        <select name="organizationId"><option value="">No Organization Credit</option>${organizationOptions}</select>
        <select name="organizationRole">${renderCreditRoleOptions(organizationCreditRoleOptions)}</select>
        <input name="genres" placeholder="Genres (comma separated)" />
        <select name="albumId"><option value="">No album</option>${albumOptions}</select>
        <label><input type="checkbox" name="inheritAlbumPrimaryCredits" value="true" checked /> Inherit the selected Album's primary Artists</label>
        <label><input type="checkbox" name="attributionUnknown" value="true" /> Attribution is not documented</label>
        <label><input type="checkbox" name="promoteToAlbumPrimary" value="true" /> If the selected participant is primary, also add them to the Album</label>
        <p class="drag-help">Choose an Artist, an Organization, inherited Album Artists, or explicitly mark attribution as not documented. Album promotion is off by default.</p>
        <input name="releaseDate" type="date" />
        <input name="duration" placeholder="Duration (e.g. 03:30)" />
        <input name="formatType" placeholder="Format type (e.g. MP3)" />
        <input name="formatBitrate" placeholder="Bitrate (e.g. 320)" />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
        <input type="file" name="audioFile" accept="audio/*" required />
        <button type="submit">Create and Upload Audio Track</button>
      </form>
      ${bulkAudioUploadBlock}
    </div>

    <div class="card object-workspace object-workspace--organization" id="organization-workspace">
      <h3>Create Organization</h3>
      <p class="muted">Use this for a label, publisher, distributor, archive, broadcaster, studio, or other institution. Do not create it as an Artist.</p>
      <form method="POST" action="/content/manage/organization/create">
        <label>Name<input name="name" required maxlength="200" /></label>
        <label>Type<select name="organizationType">${organizationTypes.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label>
        <label>Description<textarea name="description" rows="3"></textarea></label>
        <button type="submit">Create Organization</button>
      </form>
      <details${prefillOrganization ? ' open' : ''}><summary>Update an Organization</summary>
        <form method="POST" action="/content/manage/organization/update"${prefillOrganization ? '' : ' data-reference-form'}>
          ${organizationUpdateTarget}
          <label>Name<input name="name" required maxlength="200" value="${escapeHtml(String(prefillOrganization?.name ?? ''))}" /></label>
          <label>Type<select name="organizationType">${organizationTypeOptions}</select></label>
          <label>Description<textarea name="description" rows="3">${escapeHtml(String(prefillOrganization?.description ?? ''))}</textarea></label>
          <button type="submit"${prefillOrganization ? '' : ' data-reference-submit disabled'}>Update Organization</button>
        </form>
      </details>
      ${prefillOrganization ? `<hr /><h3>Create a Release for this Organization</h3>
        <p class="muted">Creates an Album with this Organization as its documented institutional Credit.</p>
        <form method="POST" action="/content/manage/organization/release/create">
          <input type="hidden" name="organizationId" value="${escapeHtml(prefillOrganizationId)}" />
          <label>Album title<input name="title" required maxlength="300" /></label>
          <label>Release date<input name="releaseDate" type="date" /></label>
          <label>Role<select name="role">${organizationCreditRoleOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <button type="submit">Create Organization Release</button>
        </form>` : '<p class="muted">Choose Edit from the Organization inventory to create a release without copying IDs.</p>'}
      <details><summary>Delete an unused Organization</summary>
        <p class="muted">Deletion is blocked while any Album or Soundtrack still credits the Organization.</p>
        <form method="POST" action="/content/manage/organization/delete" data-reference-form>
          <div class="reference-picker" data-reference-picker data-reference-type="organization">
            <label>Find Organization<input type="search" data-reference-query autocomplete="off" /></label>
            <button class="button--secondary" type="button" data-reference-search>Search</button>
            <label>Search results<select name="organizationId" data-reference-results required disabled><option value="">Search first</option></select></label>
            <p class="drag-help" data-reference-status role="status" aria-live="polite"></p>
          </div>
          <button data-danger type="submit" data-reference-submit disabled>Delete Organization</button>
        </form>
      </details>
    </div>
  </div>

    <div class="section-heading surface-catalog" id="quick-linking"><div><p class="eyebrow">Advanced relationships</p><h2>Quick Linking</h2></div></div>
    <div class="grid surface-catalog" id="catalog-quick-linking-tools">
        <div class="card">
            <h3>Link Track to Album</h3>
            <form method="POST" action="/content/manage/link/track-album">
                <input name="audioTrackId" placeholder="Audio Track ID" required />
                <input name="albumId" placeholder="Album ID" required />
                <button type="submit">Link Track and Album</button>
            </form>
            <p>Sets track.albumId and ensures album.audioTrackIds contains the track.</p>
        </div>

        <div class="card">
            <h3>Link Album to Artist</h3>
            <form method="POST" action="/content/manage/link/album-artist">
                <input name="albumId" placeholder="Album ID" required />
                <input name="artistId" placeholder="Artist ID" required />
                <button type="submit">Link Album and Artist</button>
            </form>
            <p>Adds albumId into artist.albumIds if missing.</p>
        </div>

        <div class="card">
            <h3>Link Track to Artist</h3>
            <form method="POST" action="/content/manage/link/track-artist">
                <input name="audioTrackId" placeholder="Audio Track ID" required />
                <input name="artistId" placeholder="Artist ID" required />
                <button type="submit">Link Track and Artist</button>
            </form>
            <p>Adds artistId to track.artistIds. Tracks are the source of truth for artist relationships.</p>
        </div>
    </div>

    <div class="section-heading surface-catalog" id="update-delete"><div><p class="eyebrow">Maintenance</p><h2>Update / Delete</h2></div></div>
  <div class="grid surface-catalog object-workspaces" id="catalog-object-workspaces">
        <div class="card object-workspace object-workspace--artist" id="artist-update-card">
      <h3>Artist workspace</h3>
      ${prefillArtist
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillArtist.name ?? 'Artist'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillArtistId}">Copy ID</button><a href="/content/manage?view=catalog#catalog-content">Choose another Artist</a></div>`
        : `<p class="muted">Choose Edit from the Artist inventory, or load a known ID.</p><form method="GET" action="/content/manage#artist-update-card">
                <input type="hidden" name="prefillType" value="artist" />
                <input name="prefillId" value="${prefillArtistId}" placeholder="Artist ID" required />
                <button type="submit">Load Current</button>
            </form>`}
      ${prefillArtist ? `<hr />
      <h3>Details</h3>
      <form method="POST" action="/content/manage/artist/update-metadata">
                <input type="hidden" name="artistId" value="${prefillArtistId}" required />
                <label>Artist name<input name="name" value="${escapeHtml(String(prefillArtist?.name ?? ''))}" required /></label>
                <label>Biography<textarea name="bio" rows="4">${escapeHtml(String(prefillArtist?.bio ?? ''))}</textarea></label>
                <label>Birth date<input name="birthDate" value="${escapeHtml(toDateInputValue(prefillArtist?.birthDate))}" type="date" /></label>
        <button type="submit">Save Artist Details</button>
      </form>
      <hr />
      <h3>Cover art</h3>
      <form method="POST" action="/content/manage/artist/update-cover-art" enctype="multipart/form-data">
                <input type="hidden" name="artistId" value="${prefillArtistId}" required />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
        <button type="submit">Update Cover Art</button>
      </form>
      <hr />
      <section id="artist-albums">
        <h3>Albums</h3>
        <p class="muted">Add or remove memberships here. Removing a membership does not delete the Album or its Soundtracks.</p>
        ${Array.isArray(prefillArtist.albumIds) && prefillArtist.albumIds.length > 0
            ? `<ul class="linked-content artist-album-memberships">${prefillArtist.albumIds.map((albumId: unknown) => {
                const canonicalId = String(albumId);
                const album = prefillArtistAlbums.find((candidate) => contentId(candidate) === canonicalId);
                const label = album ? String(album.title ?? 'Untitled album') : `Unavailable Album (${canonicalId})`;
                return `<li><span>${escapeHtml(label)}</span><form method="POST" action="/content/manage/artist/albums/remove"><input type="hidden" name="artistId" value="${prefillArtistId}" /><input type="hidden" name="albumId" value="${escapeHtml(canonicalId)}" /><button class="button--secondary" type="submit">Remove from Artist</button></form></li>`;
            }).join('')}</ul>`
            : '<p class="empty-linked-content">No Albums linked yet.</p>'}
        <form method="POST" action="/content/manage/artist/albums/add" data-reference-form>
          <input type="hidden" name="artistId" value="${prefillArtistId}" />
          <div class="reference-picker" data-reference-picker data-reference-type="album">
            <label>Find an Album<input type="search" data-reference-query placeholder="Search by Album title" autocomplete="off" /></label>
            <button class="button--secondary" type="button" data-reference-search>Search Albums</button>
            <label>Search results<select name="albumId" data-reference-results required disabled><option value="">Search for an Album first</option></select></label>
            <p class="drag-help" data-reference-status role="status" aria-live="polite"></p>
          </div>
          <button type="submit" data-reference-submit disabled>Add Existing Album</button>
        </form>
        <details class="advanced-tools">
          <summary>Create a new Album for this Artist</summary>
          <form method="POST" action="/content/manage/artist/albums/create" enctype="multipart/form-data">
            <input type="hidden" name="artistId" value="${prefillArtistId}" />
            <label>Album title<input name="title" required /></label>
            <label>Release date<input name="releaseDate" type="date" /></label>
            <label>Cover art (optional)<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
            <button type="submit">Create and Add Album</button>
          </form>
        </details>
      </section>
      <hr />` : '<p class="muted">Load an Artist to edit details and Album memberships.</p>'}
      ${prefillArtist ? `<section class="card danger-zone workspace-section" aria-labelledby="delete-artist-heading"><h3 id="delete-artist-heading">Danger zone</h3><p>Deletion also removes owned media only through the protected lifecycle cleanup.</p><form method="POST" action="/content/manage/artist/delete"><input type="hidden" name="artistId" value="${prefillArtistId}" required /><button data-danger type="submit">Delete Artist</button></form></section>` : ''}
    </div>

        <div class="card object-workspace object-workspace--album" id="album-update-card">
      <h3>Album</h3>
      ${prefillAlbum
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillAlbum.title ?? 'Album'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillAlbumId}">Copy ID</button><a href="/content/manage?view=catalog#catalog-content">Choose another Album</a></div>`
        : `<p class="muted">Choose Edit from the Album inventory, or load a known ID.</p><form method="GET" action="/content/manage#album-update-card">
                <input type="hidden" name="prefillType" value="album" />
                <input name="prefillId" value="${prefillAlbumId}" placeholder="Album ID" required />
                <button type="submit">Load Current</button>
            </form>`}
      ${prefillAlbum ? `<section class="workspace-section" aria-labelledby="album-details-heading"><h3 id="album-details-heading">Details and media</h3><form method="POST" action="/content/manage/album/update" enctype="multipart/form-data">
                <input type="hidden" name="albumId" value="${prefillAlbumId}" required />
                <input name="title" value="${escapeHtml(String(prefillAlbum?.title ?? ''))}" placeholder="New Title (optional)" />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
                <input name="audioTrackIds" value="${escapeHtml(toCsvInput(prefillAlbum?.audioTrackIds))}" placeholder="Audio Track IDs (comma separated)" />
                <input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAlbum?.releaseDate))}" type="date" />
        <button type="submit">Update Album</button>
      </form></section>
      <section class="workspace-section">${renderCreditEditor('album', prefillAlbumId, prefillAlbum, prefillCreditSubjectLabels)}</section>
      <section class="card danger-zone workspace-section" aria-labelledby="delete-album-heading"><h3 id="delete-album-heading">Danger zone</h3><p>Deletion keeps lifecycle evidence until every owned media object is safely cleaned up.</p><form method="POST" action="/content/manage/album/delete"><input type="hidden" name="albumId" value="${prefillAlbumId}" required /><button data-danger type="submit">Delete Album</button></form></section>` : '<p class="empty-linked-content">No Album selected.</p>'}
    </div>

        <div class="card object-workspace object-workspace--audioTrack" id="audio-track-update-card">
      <h3>Soundtrack</h3>
      ${prefillAudioTrack
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillAudioTrack.title ?? 'Soundtrack'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillAudioTrackId}">Copy ID</button><a href="/content/manage?view=catalog#catalog-content">Choose another Soundtrack</a></div>`
        : `<p class="muted">Choose Edit from the Soundtrack inventory, or load a known ID.</p><form method="GET" action="/content/manage#audio-track-update-card">
                <input type="hidden" name="prefillType" value="audioTrack" />
                <input name="prefillId" value="${prefillAudioTrackId}" placeholder="Audio Track ID" required />
                <button type="submit">Load Current</button>
            </form>`}
      ${prefillAudioTrack ? `<section class="workspace-section" aria-labelledby="soundtrack-details-heading"><h3 id="soundtrack-details-heading">Details and cover art</h3><form method="POST" action="/content/manage/audioTrack/update" enctype="multipart/form-data">
                <input type="hidden" name="audioTrackId" value="${prefillAudioTrackId}" required />
                <input name="title" value="${escapeHtml(String(prefillAudioTrack?.title ?? ''))}" placeholder="New Title (optional)" />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
                <input name="artistIds" value="${escapeHtml(toCsvInput(prefillAudioTrack?.artistIds))}" placeholder="Artist IDs (comma separated)" />
                <input name="genres" value="${escapeHtml(toCsvInput(prefillAudioTrack?.genres))}" placeholder="Genres (comma separated)" />
                <input name="albumId" value="${escapeHtml(String(prefillAudioTrack?.albumId ?? ''))}" placeholder="Album ID" />
                <input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAudioTrack?.releaseDate))}" type="date" />
                <input name="duration" value="${escapeHtml(String(prefillAudioTrack?.duration ?? ''))}" placeholder="Duration (e.g. 03:30)" />
                <input name="formatType" value="${escapeHtml(String(prefillAudioTrack?.format?.type ?? ''))}" placeholder="Format type (e.g. MP3)" />
                <input name="formatBitrate" value="${escapeHtml(String(prefillAudioTrack?.format?.bitrate ?? ''))}" placeholder="Bitrate (e.g. 320)" />
        <button type="submit">Update Audio Track</button>
      </form></section>
      <section class="workspace-section">${renderCreditEditor('audioTrack', prefillAudioTrackId, prefillAudioTrack, prefillCreditSubjectLabels)}</section>
      <section class="workspace-section" aria-labelledby="replace-audio-heading"><h3 id="replace-audio-heading">Stored audio</h3><p class="muted">Replacing audio publishes the new object before cleaning up the previous one.</p><form method="POST" action="/content/manage/audioTrack/upload" enctype="multipart/form-data"><input type="hidden" name="audioTrackId" value="${prefillAudioTrackId || selectedUploadTrackId}" required /><input type="file" name="audioFile" accept="audio/*" required /><button type="submit">Replace Audio File</button></form></section>
      <section class="card danger-zone workspace-section" aria-labelledby="delete-soundtrack-heading"><h3 id="delete-soundtrack-heading">Danger zone</h3><p>Deletion keeps the record retryable until storage cleanup completes.</p><form method="POST" action="/content/manage/audioTrack/delete"><input type="hidden" name="audioTrackId" value="${prefillAudioTrackId}" required /><button data-danger type="submit">Delete Audio Track</button></form></section>` : '<p class="empty-linked-content">No Soundtrack selected.</p>'}
    </div>
  </div>
  </main>
  <script src="/assets/browser-session-forms.js"></script>
  <script src="/assets/content-manager.js"></script>
</body>
</html>`;
};

const getContentProvenanceId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?view=catalog&message=${encodeURIComponent(message)}`);
};

/** Keeps controller-level Content Manager access admin-only if route guards are bypassed. */
const rejectNonAdminManagerRequest = (req: AuthenticatedRequest, res: Response) => {
    if (req.auth?.role === 'admin') return false;
    res.status(403).type('text/plain').send('Administrator access is required.');
    return true;
};

const respondToUploadError = (req: Request, res: Response, message: string, status: number = 400) => {
    if (req.get('X-Requested-With') === 'XMLHttpRequest') {
        return res.status(status).json({ message });
    }
    return redirectWithMessage(res, message);
};

const loadCreditSubjectLabels = async (owners: any[]) => {
    const subjects = new Map<string, { subjectType: 'artist' | 'organization'; subjectId: string }>();
    for (const owner of owners) {
        for (const credit of Array.isArray(owner?.credits) ? owner.credits : []) {
            const subjectType = credit?.subjectType === 'organization' ? 'organization' : 'artist';
            const subjectId = String(credit?.subjectId ?? '').trim().toLowerCase();
            if (/^[0-9a-f]{24}$/.test(subjectId)) {
                subjects.set(`${subjectType}:${subjectId}`, { subjectType, subjectId });
            }
        }
    }
    const labels: Record<string, string> = {};
    await Promise.all([...subjects.entries()].slice(0, 100).map(async ([key, subject]) => {
        try {
            const record: any = subject.subjectType === 'artist'
                ? await Artist.findReadyById(subject.subjectId)
                : await Organization.findReadyById(subject.subjectId);
            if (record?.name) labels[key] = String(record.name);
        } catch {
            // Missing or malformed legacy subjects remain visibly unavailable in the editor.
        }
    }));
    return labels;
};

export const renderAudioTracksPageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage%2Faudio-tracks');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const page = normalizeManagementInventoryPage(req.query.page);
        const records = await AudioTrack.fetchAll(
            inventoryLimit,
            managementInventoryOffset(page)
        );
        const tracks = toManagementInventoryPage(records, page);
        return res.status(200).send(renderAudioTracksPage(authReq.auth.userId, authReq.auth.email, tracks.items, {
            page: tracks.page,
            hasPrevious: tracks.hasPrevious,
            hasNext: tracks.hasNext
        }));
    } catch (error) {
        return next(error);
    }
};

export const renderManagePageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const [inventory, s3StorageSummaryResult, releaseOperations] = await Promise.all([
            loadGlobalManagementInventory(req),
            loadS3StorageSummary(),
            listArtistReleaseOperations(authReq.auth.userId)
        ]);

        const queryMessage = String(req.query.message ?? '');
        let message = queryMessage;
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const prefillType = String(req.query.prefillType ?? '').trim();
        const prefillId = String(req.query.prefillId ?? '').trim();

        let prefillArtist: any | null = null;
        let prefillArtistAlbums: any[] = [];
        let prefillAlbum: any | null = null;
        let prefillAudioTrack: any | null = null;
        let prefillOrganization: any | null = null;
        let prefillArtistId = '';
        let prefillAlbumId = '';
        let prefillAudioTrackId = selectedUploadTrackId;

        if (prefillType && prefillId) {
            try {
                if (prefillType === 'artist') {
                    const artist = await Artist.findById(prefillId);
                    if (artist) {
                        prefillArtist = artist;
                        prefillArtistId = prefillId;
                        const albumIds = Array.isArray((artist as any).albumIds)
                            ? (artist as any).albumIds.map(String).slice(0, 100)
                            : [];
                        prefillArtistAlbums = (await Promise.all(albumIds.map(async (albumId: string) => {
                            try {
                                return await Album.findById(albumId);
                            } catch {
                                return null;
                            }
                        }))).filter(Boolean);
                    } else if (!message) {
                        message = 'Unable to load artist for this ID.';
                    }
                }

                if (prefillType === 'album') {
                    const album = await Album.findById(prefillId);
                    if (album) {
                        prefillAlbum = album;
                        prefillAlbumId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load album for this ID.';
                    }
                }

                if (prefillType === 'audioTrack') {
                    const track = await AudioTrack.findById(prefillId);
                    if (track) {
                        prefillAudioTrack = track;
                        prefillAudioTrackId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load audio track for this ID.';
                    }
                }

                if (prefillType === 'organization') {
                    const organization = await Organization.findById(prefillId);
                    if (organization) {
                        prefillOrganization = organization;
                    } else if (!message) {
                        message = 'Unable to load Organization for this ID.';
                    }
                }
            } catch (error) {
                if (!message) {
                    message = 'Unable to load current values: invalid or inaccessible ID.';
                }
            }
        }

        const prefillCreditSubjectLabels = await loadCreditSubjectLabels([
            prefillAlbum,
            prefillAudioTrack
        ]);

        return res.status(200).send(renderManagePage({
            userId: authReq.auth.userId,
            userEmail: authReq.auth.email,
            isAdmin: authReq.auth.role === 'admin',
            message,
            selectedUploadTrackId,
            ...inventory,
            s3StorageSummary: s3StorageSummaryResult.summary,
            s3StorageSummaryError: s3StorageSummaryResult.errorCode,
            prefillArtistId,
            prefillAlbumId,
            prefillAudioTrackId,
            prefillArtist,
            prefillArtistAlbums,
            prefillAlbum,
            prefillAudioTrack,
            prefillOrganization,
            prefillCreditSubjectLabels,
            releaseSetupToken: randomUUID().replace(/-/g, '_'),
            releaseOperations,
            managerView: req.query.view ? managerViewFromQuery(req.query.view) : prefillType ? 'catalog' : 'overview'
        }));
    } catch (error) {
        return next(error);
    }
};

export const searchContentWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const rawQuery = boundedSearchQuery(req.query.q);
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const limit = boundedLimit(req.query.limit, 10, 50);

        const [artists, organizations, albums, audioTracks, inventory, s3StorageSummaryResult, releaseOperations] = await Promise.all([
            rawQuery ? Artist.searchByName(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? Organization.searchByName(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? Album.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? AudioTrack.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            loadGlobalManagementInventory(req),
            loadS3StorageSummary(),
            listArtistReleaseOperations(authReq.auth.userId)
        ]);

        return res.status(200).send(renderManagePage({
            userId: authReq.auth.userId,
            userEmail: authReq.auth.email,
            isAdmin: authReq.auth.role === 'admin',
            searchQuery: rawQuery,
            selectedUploadTrackId,
            artists,
            organizations,
            albums,
            audioTracks,
            ...inventory,
            s3StorageSummary: s3StorageSummaryResult.summary,
            s3StorageSummaryError: s3StorageSummaryResult.errorCode,
            releaseSetupToken: randomUUID().replace(/-/g, '_'),
            releaseOperations,
            managerView: 'catalog'
        }));
    } catch (error) {
        return next(error);
    }
};

/** Supplies bounded, global named options to Content Manager relationship pickers. */
export const searchManagementReferencesWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.status(401).json({ message: 'Authentication is required.' });
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const type = String(req.query.type ?? '').trim();
        const query = boundedSearchQuery(req.query.q);
        if (!query || !['artist', 'album', 'audioTrack', 'organization'].includes(type)) {
            return res.status(400).json({ message: 'A valid type and search query are required.' });
        }
        const limit = boundedLimit(req.query.limit, 20, 50);
        const records = type === 'artist'
            ? await Artist.searchByName(query, limit)
            : type === 'album'
                ? await Album.searchByTitle(query, limit)
                : type === 'organization'
                    ? await Organization.searchByName(query, limit)
                    : await AudioTrack.searchByTitle(query, limit);
        return res.status(200).json({
            items: records.map((record: any) => ({
                id: contentId(record),
                label: String(type === 'artist' || type === 'organization'
                    ? record.name
                    : record.title ?? '')
            }))
        });
    } catch (error) {
        return next(error);
    }
};

const creditOwnerRedirect = (
    res: Response,
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    message: string
) => res.redirect(`/content/manage?view=catalog&prefillType=${ownerType}&prefillId=${encodeURIComponent(ownerId)}&message=${encodeURIComponent(message)}#${ownerType === 'album' ? 'album-update-card' : 'audio-track-update-card'}`);

/** Creates a non-Artist institution that can receive release Credits. */
export const createOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const name = String(req.body.name ?? '').trim();
        const organizationType = String(req.body.organizationType ?? 'other');
        if (!name || !organizationTypes.includes(organizationType as any)) {
            return redirectWithMessage(res, 'Enter an Organization name and valid type.');
        }
        const organization = new Organization(
            name,
            organizationType as any,
            String(req.body.description ?? ''),
            authReq.auth.userId
        );
        const result = await organization.save();
        return redirectWithMessage(res, `Organization created: ${String(result.insertedId)}.`);
    } catch (error) {
        return next(error);
    }
};

/** Creates an Organization-only Album with its institutional Credit fenced in the insert transaction. */
export const createOrganizationReleaseWeb = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const organizationId = String(req.body.organizationId ?? '').trim().toLowerCase();
        const title = normalizeUtf8Text(String(req.body.title ?? '').trim());
        const role = String(req.body.role ?? 'publisher');
        if (!ObjectId.isValid(organizationId) || !title || title.length > 300
            || !organizationCreditRoleOptions.some(([value]) => value === role)) {
            return redirectWithMessage(res, 'Choose a valid Organization, Album title, and institutional role.');
        }
        const albumId = new ObjectId();
        const album = new Album(
            title,
            '',
            [] as unknown as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumId
        );
        album.credits = [{
            creditId: createCatalogCreditId(),
            subjectType: 'organization',
            subjectId: organizationId,
            role: role as any,
            order: 0
        }];
        album.attributionStatus = 'documented';
        album.creditRevision = 1;
        await album.save();
        const message = `Organization release created: ${title}.`;
        return res.redirect(`/content/manage?view=catalog&prefillType=album&prefillId=${albumId.toHexString()}&message=${encodeURIComponent(message)}#album-update-card`);
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Updates Organization metadata without changing any Catalog Credits. */
export const updateOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const organizationId = String(req.body.organizationId ?? '').trim();
        const organizationType = String(req.body.organizationType ?? '');
        const name = String(req.body.name ?? '').trim();
        if (!name || !organizationTypes.includes(organizationType as any)) {
            return redirectWithMessage(res, 'Enter an Organization name and valid type.');
        }
        await Organization.updateById(organizationId, {
            name,
            organizationType,
            description: String(req.body.description ?? '')
        });
        return redirectWithMessage(res, 'Organization updated successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Deletes only an Organization that no Album or Soundtrack still credits. */
export const deleteOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        await deleteUnreferencedOrganization(String(req.body.organizationId ?? '').trim());
        return redirectWithMessage(res, 'Organization deleted successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Adds one ordered role-bearing Credit from a named Content Manager selection. */
export const addCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const subjectType = String(req.body.subjectType ?? '');
        const subjectId = String(req.body.subjectId ?? '').trim();
        const role = String(req.body.role ?? '');
        if (!catalogCreditSubjectTypes.includes(subjectType as any)
            || !catalogCreditRoles.includes(role as any)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Choose a valid Credit subject and role.');
        }
        const credit = {
            creditId: createCatalogCreditId(),
            subjectType,
            subjectId,
            role,
            order: 0
        };
        if (ownerType === 'audioTrack') {
            await addSoundtrackCredit(
                ownerId,
                credit,
                req.body.promoteToAlbumPrimary === 'true'
            );
        } else {
            await addCatalogCredit(ownerType, ownerId, credit);
        }
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit added successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
            return creditOwnerRedirect(
                res,
                ownerType,
                String(req.body.ownerId ?? ''),
                String((error as Error).message)
            );
        }
        return next(error);
    }
};

/** Removes one Credit and explicitly marks an empty owner as attribution unknown. */
export const removeCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        await removeCatalogCredit(
            ownerType,
            ownerId,
            String(req.body.creditId ?? '').trim(),
            'unknown'
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit removed successfully.');
    } catch (error) {
        return next(error);
    }
};

const loadCreditOwner = (ownerType: 'album' | 'audioTrack', ownerId: string) => ownerType === 'album'
    ? Album.findById(ownerId)
    : AudioTrack.findById(ownerId);

/** Changes one Credit role while preserving its stable ID and order. */
export const updateCatalogCreditRoleWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const creditId = String(req.body.creditId ?? '').trim();
        const role = String(req.body.role ?? '').trim();
        if (!catalogCreditRoles.includes(role as any)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Choose a valid Credit role.');
        }
        const owner: any = await loadCreditOwner(ownerType, ownerId);
        const credits = Array.isArray(owner?.credits) ? owner.credits : [];
        if (!credits.some((credit: any) => credit.creditId === creditId)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Credit not found. Reload and try again.');
        }
        await replaceCatalogCredits(
            ownerType,
            ownerId,
            credits.map((credit: any) => credit.creditId === creditId ? { ...credit, role } : credit),
            'documented',
            Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit role updated successfully.');
    } catch (error) {
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return creditOwnerRedirect(res, ownerType, String(req.body.ownerId ?? ''), String((error as Error).message));
        }
        return next(error);
    }
};

/** Moves one Credit by one position using optimistic revision control. */
export const reorderCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const creditId = String(req.body.creditId ?? '').trim();
        const owner: any = await loadCreditOwner(ownerType, ownerId);
        const credits = Array.isArray(owner?.credits) ? owner.credits : [];
        const from = credits.findIndex((credit: any) => credit.creditId === creditId);
        const delta = req.body.direction === 'up' ? -1 : req.body.direction === 'down' ? 1 : 0;
        const to = from + delta;
        if (from < 0 || delta === 0 || to < 0 || to >= credits.length) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Credit cannot be moved in that direction.');
        }
        const orderedIds = credits.map((credit: any) => String(credit.creditId));
        [orderedIds[from], orderedIds[to]] = [orderedIds[to], orderedIds[from]];
        await reorderCatalogCredits(
            ownerType,
            ownerId,
            orderedIds,
            Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit order updated successfully.');
    } catch (error) {
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return creditOwnerRedirect(res, ownerType, String(req.body.ownerId ?? ''), String((error as Error).message));
        }
        return next(error);
    }
};

/** Explicitly records that attribution is undocumented instead of creating a fake subject. */
export const markCatalogAttributionUnknownWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        await replaceCatalogCredits(ownerType, ownerId, [], 'unknown');
        return creditOwnerRedirect(res, ownerType, ownerId, 'Attribution marked as not documented.');
    } catch (error) {
        return next(error);
    }
};

/** Submits the reviewed, resumable Artist release setup workflow. */
export const createArtistReleaseWorkflowWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistMode = req.body.artistMode === 'new' ? 'new' : 'existing';
        const existingArtistId = String(req.body.existingArtistId ?? '').trim();
        const artistName = String(req.body.artistName ?? '').trim();
        const albumTitle = String(req.body.albumTitle ?? '').trim();
        if ((artistMode === 'existing' && !existingArtistId)
            || (artistMode === 'new' && !artistName)
            || !albumTitle) {
            return redirectWithMessage(res, 'Choose or name an Artist and enter an Album title.');
        }
        const createCarousel = req.body.createCarousel === 'true';
        const requestedPage = String(req.body.pageSlug ?? '').trim();
        const pageSlug = createCarousel && (requestedPage === 'home' || requestedPage === 'library')
            ? requestedPage
            : undefined;
        const positionRaw = String(req.body.pagePosition ?? '').trim();
        const pagePosition = positionRaw && Number.isFinite(Number(positionRaw))
            ? Math.max(0, Math.floor(Number(positionRaw)))
            : undefined;
        const requestedLimit = Number(req.body.carouselLimit ?? 20);
        const result = await runArtistReleaseWorkflow(
            authReq.auth.userId,
            {
                idempotencyToken: String(req.body.idempotencyToken ?? '').trim(),
                artistMode,
                existingArtistId: artistMode === 'existing' ? existingArtistId : undefined,
                artistName: artistMode === 'new' ? artistName : undefined,
                artistBio: artistMode === 'new' ? String(req.body.artistBio ?? '') : undefined,
                artistBirthDate: parseDateInput(String(req.body.artistBirthDate ?? '')),
                artistCoverArtRequested: Boolean(getUploadedFile(req, 'artistCoverArtFile')),
                albumTitle,
                albumReleaseDate: parseDateInput(String(req.body.albumReleaseDate ?? '')),
                albumCoverArtRequested: Boolean(getUploadedFile(req, 'albumCoverArtFile')),
                createCarousel,
                carouselName: createCarousel ? String(req.body.carouselName ?? '').trim() || undefined : undefined,
                carouselSort: req.body.carouselSort === 'titleAsc' ? 'titleAsc' : 'releaseDateDesc',
                carouselLimit: Number.isFinite(requestedLimit)
                    ? Math.max(1, Math.min(Math.floor(requestedLimit), 100))
                    : 20,
                pageSlug,
                pagePosition
            },
            {
                artistCoverArtFile: getUploadedFile(req, 'artistCoverArtFile'),
                albumCoverArtFile: getUploadedFile(req, 'albumCoverArtFile')
            }
        );
        const message = `Artist release setup completed. Artist ${result.artistId}; Album ${result.albumId}${result.carouselId ? `; Carousel ${result.carouselId}` : ''}.`;
        return res.redirect(`/content/manage?view=operations&workflowComplete=1&prefillType=artist&prefillId=${encodeURIComponent(result.artistId ?? '')}&message=${encodeURIComponent(message)}#workflow-operations`);
    } catch (error) {
        if ((error as any)?.operationId) {
            return res.redirect(`/content/manage?view=operations&message=${encodeURIComponent(`Artist release setup needs attention. Operation ${(error as any).operationId} retained every completed step; do not recreate completed content.`)}#workflow-operations`);
        }
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Retries only retained intent and completed IDs from a prior setup operation. */
export const retryArtistReleaseWorkflowWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const result = await resumeArtistReleaseWorkflow(
            authReq.auth.userId,
            String(req.body.operationId ?? '').trim()
        );
        return res.redirect(`/content/manage?view=operations&workflowComplete=1&prefillType=artist&prefillId=${encodeURIComponent(result.artistId ?? '')}&message=${encodeURIComponent('Artist release setup completed after retry.')}#workflow-operations`);
    } catch (error) {
        if ((error as any)?.operationId) {
            return res.redirect(`/content/manage?view=operations&message=${encodeURIComponent(`Artist release setup still needs attention: ${String((error as Error).message)}`)}#workflow-operations`);
        }
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

export const createArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumIds = parseCsv(String(req.body.albumIds ?? ''));
        const albumValidation = await validateContentReferences('album', albumIds);
        if (!albumValidation.valid) {
            return redirectWithMessage(res, albumValidation.message!);
        }

        const artistObjectId = new ObjectId();
        const artist = new Artist(
            String(req.body.name ?? ''),
            parseDateInput(String(req.body.birthDate ?? '')),
            String(req.body.bio ?? ''),
            String(req.body.coverArtUrl ?? ''),
            albumValidation.ids as [string],
            authReq.auth.userId,
            artistObjectId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const artistId = artistObjectId.toHexString();
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'artist',
                artistId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewArtist(artist, coverArt);
        if (albumValidation.ids.length > 0) {
            await replaceArtistAlbums(artistId, albumValidation.ids);
        }
        return redirectWithMessage(res, 'Artist created successfully.');
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                'Artist creation outcome could not be confirmed. Reconciliation is required before retrying.'
            );
        }
        if ((error as any)?.code === 'artist_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Artist was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

export const updateArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.name) updatePayload.name = String(req.body.name);
        if (req.body.bio) updatePayload.bio = String(req.body.bio);
        const requestedAlbumIds = req.body.albumIds !== undefined
            ? parseCsv(String(req.body.albumIds))
            : undefined;
        if (requestedAlbumIds) {
            const validation = await validateContentReferences('album', requestedAlbumIds);
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
        }
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'artist',
                artistId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (removeCoverArt) {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }
        const cleanup = await updateCoverArtOwnerAndCleanup(
            artistId,
            updatePayload,
            artist.coverArtId,
            removeCoverArt || Boolean(
                replacementCoverArtId && artist.coverArtId !== replacementCoverArtId
            ),
            {
                ownerType: 'artist',
                updateOwner: (id, update) => Artist.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Artist.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (cleanup.cleanupError) {
            console.log(`Unable to delete detached artist cover art ${artist.coverArtId}:`, cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'Artist was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'Artist was not updated because its cover art changed concurrently.'
            );
        }
        if (requestedAlbumIds) await replaceArtistAlbums(artistId, requestedAlbumIds);
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Artist updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Artist updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

/** Updates Artist text/date metadata without entering multipart upload capacity. */
export const updateArtistMetadataWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const validation = await validateContentReferences('artist', [artistId]);
        if (!validation.valid) return redirectWithMessage(res, validation.message!);
        const name = String(req.body.name ?? '').trim();
        if (!name) return redirectWithMessage(res, 'Artist name is required.');

        await Artist.updateById(artistId, {
            name,
            bio: String(req.body.bio ?? ''),
            birthDate: parseDateInput(String(req.body.birthDate ?? ''))
        });
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent('Artist details updated successfully.')}#artist-update-card`);
    } catch (error) {
        return next(error);
    }
};

/** Replaces or removes Artist cover art on the upload-protected route only. */
export const updateArtistCoverArtWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const validation = await validateContentReferences('artist', [artistId]);
        if (!validation.valid) return redirectWithMessage(res, validation.message!);
        const artist = await Artist.findReadyById(artistId);
        if (!artist) return redirectWithMessage(res, 'Artist not found.');

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (!coverArtFile && !removeCoverArt) {
            return redirectWithMessage(res, 'Choose replacement cover art or select Remove current cover art.');
        }
        const updatePayload: Record<string, unknown> = {};
        let replacementCoverArtId: string | undefined;
        if (coverArtFile) {
            const coverArt = await uploadCoverArt('artist', artistId, coverArtFile, authReq.auth.userId);
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }
        const cleanup = await updateCoverArtOwnerAndCleanup(
            artistId,
            updatePayload,
            artist.coverArtId,
            removeCoverArt || Boolean(replacementCoverArtId && artist.coverArtId !== replacementCoverArtId),
            {
                ownerType: 'artist',
                updateOwner: (id, update) => Artist.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Artist.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (!cleanup.updateApplied) {
            return redirectWithMessage(res, cleanup.cleanupPending
                ? 'Artist cover art was not updated because lifecycle evidence requires reconciliation.'
                : 'Artist cover art changed concurrently.');
        }
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(cleanup.cleanupPending ? 'Artist cover art updated. Previous artwork cleanup requires reconciliation.' : 'Artist cover art updated successfully.')}#artist-update-card`);
    } catch (error) {
        return next(error);
    }
};

export const deleteArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        if (!ObjectId.isValid(artistId)
            || String(new ObjectId(artistId)) !== artistId.toLowerCase()) {
            return redirectWithMessage(res, 'Artist ID is not valid.');
        }
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        const cleanup = await deleteArtistAndReferences(artistId);
        if (!cleanup.ownerDeleted) {
            return redirectWithMessage(
                res,
                'Artist was retained for retry and lifecycle reconciliation.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Artist deleted successfully. Cover-art cleanup will need to be retried.'
                : 'Artist deleted successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const createAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackIds = parseCsv(String(req.body.audioTrackIds ?? ''));
        const trackValidation = await validateContentReferences('audioTrack', audioTrackIds);
        if (!trackValidation.valid) {
            return redirectWithMessage(res, trackValidation.message!);
        }

        const albumObjectId = new ObjectId();
        const album = new Album(
            String(req.body.title ?? ''),
            String(req.body.coverArtUrl ?? ''),
            trackValidation.ids as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumObjectId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const albumId = albumObjectId.toHexString();
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'album',
                albumId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewAlbum(album, coverArt);
        return redirectWithMessage(res, 'Album created successfully.');
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                'Album creation outcome could not be confirmed. Reconciliation is required before retrying.'
            );
        }
        if ((error as any)?.code === 'album_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Album was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

/** Creates an Album from an Artist workspace and links it before reporting success. */
export const createArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    let artistId = '';
    let createdAlbumId = '';
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const title = String(req.body.title ?? '').trim();
        if (!title) return redirectWithMessage(res, 'Album title is required.');

        const albumObjectId = new ObjectId();
        createdAlbumId = albumObjectId.toHexString();
        const album = new Album(
            title,
            '',
            [] as unknown as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumObjectId
        );
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'album',
                createdAlbumId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewAlbum(album, coverArt);
        try {
            await ensureAlbumPrimaryArtistCredit(createdAlbumId, artistId);
        } catch (linkError) {
            return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(`Album ${createdAlbumId} was created, but its Artist link did not complete. Retry the link from this workspace; do not recreate the Album.`)}#artist-albums`);
        }
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent('Album created and linked to Artist successfully.')}#artist-albums`);
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                `Album creation outcome could not be confirmed${createdAlbumId ? ` for ${createdAlbumId}` : ''}. Reconciliation is required before retrying.`
            );
        }
        if ((error as any)?.code === 'album_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Album was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

export const updateAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        const album = await Album.findReadyById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.audioTrackIds !== undefined) {
            const validation = await validateContentReferences(
                'audioTrack',
                parseCsv(String(req.body.audioTrackIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.audioTrackIds = validation.ids;
        }
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'album',
                albumId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (removeCoverArt) {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }

        const cleanup = await updateCoverArtOwnerAndCleanup(
            albumId,
            updatePayload,
            album.coverArtId,
            removeCoverArt || Boolean(
                replacementCoverArtId && album.coverArtId !== replacementCoverArtId
            ),
            {
                ownerType: 'album',
                updateOwner: (id, update) => Album.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Album.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (cleanup.cleanupError) {
            console.log(`Unable to delete detached album cover art ${album.coverArtId}:`, cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'Album was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'Album was not updated because its cover art changed concurrently.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Album updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Album updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const deleteAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        if (!ObjectId.isValid(albumId)
            || String(new ObjectId(albumId)) !== albumId.toLowerCase()) {
            return redirectWithMessage(res, 'Album ID is not valid.');
        }
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const cleanup = await deleteAlbumAndReferences(albumId);
        if (!cleanup.ownerDeleted) {
            return redirectWithMessage(
                res,
                'Album was retained for retry and lifecycle reconciliation.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Album deleted successfully. Cover-art cleanup will need to be retried.'
                : 'Album deleted successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const createAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFile = getUploadedFile(req, 'audioFile');
        if (!uploadFile) {
            return redirectWithMessage(res, 'An audio file is required to create an audio track.');
        }

        const artistId = String(req.body.artistId ?? '').trim();
        if (artistId) {
            const artistValidation = await validateContentReferences('artist', [artistId]);
            if (!artistValidation.valid) {
                return redirectWithMessage(res, artistValidation.message!);
            }
        }
        const organizationId = String(req.body.organizationId ?? '').trim();
        if (organizationId) {
            const organizationValidation = await validateContentReferences(
                'organization',
                [organizationId]
            );
            if (!organizationValidation.valid) {
                return redirectWithMessage(res, organizationValidation.message!);
            }
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return redirectWithMessage(res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
        }

        const formatType = String(req.body.formatType ?? 'MP3');
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
        const audioTrackObjectId = new ObjectId();
        const audioTrackId = audioTrackObjectId.toHexString();
        const originalFileName = normalizeUtf8Text(uploadFile.originalname);
        const artistRole = String(req.body.artistRole ?? 'primary');
        const inheritAlbumPrimary = req.body.inheritAlbumPrimaryCredits === 'true';
        const credits = proposedSoundtrackCredits(
            audioTrackId,
            album,
            artistId,
            artistRole,
            inheritAlbumPrimary,
            organizationId,
            String(req.body.organizationRole ?? 'label')
        );
        const attributionUnknown = req.body.attributionUnknown === 'true';
        if ((credits.length === 0) !== attributionUnknown) {
            return redirectWithMessage(
                res,
                credits.length === 0
                    ? 'Choose an Artist, Organization, inherited Album Artist, or mark attribution as not documented.'
                    : 'Attribution cannot be marked undocumented while Credits are selected.'
            );
        }
        const creditedArtistIds = [...new Set(credits
            .filter((credit) => credit.subjectType === 'artist')
            .map((credit) => credit.subjectId))];

        const track = new AudioTrack(
            normalizeUtf8Text(String(req.body.title ?? '')),
            creditedArtistIds as [string],
            parseCsv(String(req.body.genres ?? '')),
            albumId,
            parseDateInput(String(req.body.releaseDate ?? '')),
            String(req.body.duration ?? ''),
            new AudioFormat(formatType, Number.isNaN(bitrate as number) ? undefined : bitrate),
            String(req.body.coverArtUrl ?? ''),
            authReq.auth.userId,
            originalFileName,
            uploadFile.mimetype || 'audio/mpeg',
            audioTrackObjectId
        );
        track.credits = credits;
        track.attributionStatus = attributionUnknown ? 'unknown' : 'documented';
        track.creditRevision = 1;

        await track.save();
        const upload = await uploadAudioObject(
            audioTrackId,
            uploadFile,
            getContentProvenanceId(track) || authReq.auth.userId,
            getRequestAbortSignal(req)
        );
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            await attachCoverArtToNewOwner(audioTrackId, coverArt, {
                ownerType: 'audioTrack',
                updateOwner: (id, update) => AudioTrack.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    AudioTrack.updateCoverArtById(id, expectedImageId, update)
            });
        }

        await publishUploadedAudioTracks(albumId, [audioTrackId]);
        if (req.body.promoteToAlbumPrimary === 'true') {
            if (!albumId || !artistId || artistRole !== 'primary') {
                return redirectWithMessage(
                    res,
                    'Soundtrack published, but Album promotion requires a linked Album and Primary Artist role.'
                );
            }
            try {
                await addSoundtrackCredit(
                    audioTrackId,
                    {
                        creditId: migratedCatalogCreditId(
                            'audioTrack', audioTrackId, 'artist', artistId, 'primary'
                        ),
                        subjectType: 'artist',
                        subjectId: artistId,
                        role: 'primary',
                        order: 0
                    },
                    true,
                    1
                );
            } catch (promotionError) {
                return redirectWithMessage(
                    res,
                    (promotionError as any)?.outcomeUnknown
                        ? 'Soundtrack published, but Album promotion could not be confirmed. Run reconciliation before retrying from the Credit editor.'
                        : 'Soundtrack published with its Soundtrack Credit, but Album promotion did not complete. It remains safely Soundtrack-only and can be promoted from the Credit editor.'
                );
            }
        }

        return redirectWithMessage(
            res,
            upload.cleanupPending
                ? 'Audio track and file created successfully. Previous object cleanup will need to be retried.'
                : 'Audio track and file created successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const updateAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'Audio track ID is not valid.');
        }
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        let requestedAlbumId: string | undefined;
        let requestedArtistIds: string[] | undefined;
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.artistIds) {
            const validation = await validateContentReferences(
                'artist',
                parseCsv(String(req.body.artistIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            requestedArtistIds = validation.ids;
        }
        if (req.body.genres) updatePayload.genres = parseCsv(String(req.body.genres));
        if (req.body.albumId !== undefined) {
            const albumId = String(req.body.albumId ?? '').trim();
            if (albumId) {
                const validation = await validateContentReferences('album', [albumId]);
                if (!validation.valid) return redirectWithMessage(res, validation.message!);
                requestedAlbumId = validation.ids[0];
            } else {
                requestedAlbumId = '';
            }
        }
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (req.body.duration) updatePayload.duration = String(req.body.duration);
        if (req.body.formatType) {
            const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
            const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
            updatePayload.format = new AudioFormat(
                String(req.body.formatType),
                Number.isNaN(bitrate as number) ? undefined : bitrate
            );
        }
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (removeCoverArt) {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }

        const cleanup = Object.keys(updatePayload).length > 0 || requestedAlbumId !== undefined
            ? await updateCoverArtOwnerAndCleanup(
                audioTrackId,
                updatePayload,
                track.coverArtId,
                removeCoverArt || Boolean(
                    replacementCoverArtId && track.coverArtId !== replacementCoverArtId
                ),
                {
                    ownerType: 'audioTrack',
                    updateOwner: requestedAlbumId === undefined
                        ? (id, update) => AudioTrack.updateById(id, update)
                        : (id, update) => AudioTrack.updateWithAlbumById(
                            id,
                            requestedAlbumId,
                            update
                        ),
                    updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                        requestedAlbumId === undefined
                            ? AudioTrack.updateCoverArtById(id, expectedImageId, update)
                            : AudioTrack.updateWithAlbumAndCoverArtById(
                                id,
                                requestedAlbumId,
                                expectedImageId,
                                update
                            )
                }
            )
            : { updateApplied: true, cleanupPending: false, cleanupError: undefined };
        if (cleanup.cleanupError) {
            console.log(`Unable to delete detached audio-track cover art ${track.coverArtId}:`, cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'Audio track was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'Audio track was not updated because its cover art changed concurrently.'
            );
        }
        if (requestedArtistIds) {
            const credits = mergeLegacyArtistIdsIntoCredits(
                'audioTrack',
                audioTrackId,
                track.credits,
                requestedArtistIds
            );
            await replaceCatalogCredits(
                'audioTrack',
                audioTrackId,
                credits,
                credits.length > 0 ? 'documented' : 'unknown',
                Number.isInteger(track.creditRevision) ? track.creditRevision : 0
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Audio track updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Audio track updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const deleteAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'Audio track ID is not valid.');
        }
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        try {
            const deletion = await deleteAudioObjectAndTrack(audioTrackId);
            return redirectWithMessage(
                res,
                deletion.cleanupPending
                    ? 'Audio track deleted successfully. Cover-art cleanup will need to be retried.'
                    : 'Audio track deleted successfully.'
            );
        } catch (s3Error) {
            console.log('Audio track deletion failed for audioTrackId:', audioTrackId, s3Error);
            const outcomeUnknown = (s3Error as any)?.code === 'audio_deletion_outcome_unknown';
            return redirectWithMessage(
                res,
                outcomeUnknown
                    ? 'Audio track deletion outcome could not be confirmed. Reconciliation is required.'
                    : 'Audio track deletion could not complete. Track metadata was retained for retry and reconciliation.'
            );
        }
    } catch (error) {
        return next(error);
    }
};

export const deleteAlbumAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const selectedTrackIds = uniqueStrings(
            Array.isArray(req.body.audioTrackIds)
                ? req.body.audioTrackIds.map(String)
                : req.body.audioTrackIds ? [String(req.body.audioTrackIds)] : []
        );
        if (!albumId || selectedTrackIds.length === 0) {
            return redirectWithMessage(res, 'Select at least one audio track to delete.');
        }
        const maximumBatchDeletes = 100;
        if (selectedTrackIds.length > maximumBatchDeletes) {
            return redirectWithMessage(res, `Delete no more than ${maximumBatchDeletes} audio tracks at once.`);
        }

        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);

        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const tracks = await Promise.all(selectedTrackIds.map((trackId) =>
            ObjectId.isValid(trackId) ? AudioTrack.findById(trackId) : Promise.resolve(null)
        ));
        const associatedTrackIds = new Set(uniqueStrings([
            ...(Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds.map(String) : []),
            ...tracks.filter(Boolean).filter((track: any) => String(track.albumId ?? '') === albumId).map(contentId)
        ]));
        const deletedTrackIds: string[] = [];
        const failedTrackIds: string[] = [];
        const outcomeUnknownTrackIds: string[] = [];
        const cleanupPendingTrackIds: string[] = [];
        for (const [index, trackId] of selectedTrackIds.entries()) {
            if (!tracks[index] || !associatedTrackIds.has(trackId)) {
                failedTrackIds.push(trackId);
                continue;
            }
            try {
                const deletion = await deleteAudioObjectAndTrack(trackId);
                deletedTrackIds.push(trackId);
                if (deletion.cleanupPending) cleanupPendingTrackIds.push(trackId);
            } catch (deleteError) {
                console.log(`Unable to delete audio track ${trackId}:`, deleteError);
                failedTrackIds.push(trackId);
                if ((deleteError as any)?.code === 'audio_deletion_outcome_unknown') {
                    outcomeUnknownTrackIds.push(trackId);
                }
            }
        }

        if (failedTrackIds.length > 0) {
            return redirectWithMessage(
                res,
                `${deletedTrackIds.length} audio track(s) deleted. ${failedTrackIds.length} could not be deleted.${outcomeUnknownTrackIds.length > 0 ? ` ${outcomeUnknownTrackIds.length} deletion outcome(s) require reconciliation.` : ' Failed tracks remain recorded for retry and reconciliation.'}${cleanupPendingTrackIds.length > 0 ? ` ${cleanupPendingTrackIds.length} deleted track(s) still require cover-art lifecycle cleanup.` : ''}`
            );
        }
        if (cleanupPendingTrackIds.length > 0) {
            return redirectWithMessage(
                res,
                `${deletedTrackIds.length} audio track(s) deleted. ${cleanupPendingTrackIds.length} still require cover-art lifecycle cleanup.`
            );
        }

        return redirectWithMessage(res, `${deletedTrackIds.length} audio track(s) deleted successfully.`);
    } catch (error) {
        return next(error);
    }
};

interface WebAudioTrackUploadDependencies {
    findTrack: typeof AudioTrack.findById;
    uploadObject: typeof uploadAudioObject;
    retryPublications: typeof retryAudioTrackPublications;
}

const defaultWebAudioTrackUploadDependencies: WebAudioTrackUploadDependencies = {
    findTrack: AudioTrack.findById.bind(AudioTrack),
    uploadObject: uploadAudioObject,
    retryPublications: retryAudioTrackPublications
};

const publicationStatusForMessage = (value: string) => value === '' ? 'empty' : value;

/** Keeps the one-file Content Manager result aligned with persisted publication state. */
export const uploadAudioTrackWeb = async (
    req: Request,
    res: Response,
    next: NextFunction,
    dependencyOverrides: Partial<WebAudioTrackUploadDependencies> = {}
) => {
    try {
        const dependencies = {
            ...defaultWebAudioTrackUploadDependencies,
            ...dependencyOverrides
        };
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'Audio track ID is not valid.');
        }
        const track = await dependencies.findTrack(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'Missing audio file.');
        }

        const upload = await dependencies.uploadObject(
            audioTrackId,
            uploadFile,
            getContentProvenanceId(track) || authReq.auth.userId,
            getRequestAbortSignal(req)
        );
        const publication = await dependencies.retryPublications([audioTrackId]);
        const publicationResult = publication.results.find(
            (result) => result.audioTrackId === audioTrackId.toLowerCase()
        );
        if (!publicationResult) {
            return redirectWithMessage(
                res,
                'Audio file uploaded, but publication outcome could not be read back. Reconciliation is required.'
            );
        }
        if (publicationResult.outcome !== 'ready') {
            const publicationMessage = publicationResult.outcome === 'unknown'
                ? 'Audio file uploaded, but publication outcome could not be confirmed. Reconciliation is required.'
                : `Audio file uploaded, but publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}. Retry publication without uploading the file again.`;
            return redirectWithMessage(
                res,
                `${publicationMessage}${upload.cleanupPending ? ' Previous object cleanup also needs to be retried.' : ''}`
            );
        }

        return redirectWithMessage(
            res,
            upload.cleanupPending
                ? `Audio file uploaded successfully. Publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}. Previous object cleanup will need to be retried.`
                : `Audio file uploaded successfully. Publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}.`
        );
    } catch (error) {
        if ((error as any)?.cleanupPending !== undefined) {
            return redirectWithMessage(
                res,
                (error as any)?.outcomeUnknown
                    ? 'Audio upload outcome could not be confirmed. Reconciliation is required.'
                    : (error as any)?.cleanupPending
                        ? 'Audio upload failed and storage cleanup must be retried.'
                        : String((error as Error).message || 'Audio upload failed.')
            );
        }
        return next(error);
    }
};

export const bulkUploadAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFiles = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
        if (uploadFiles.length === 0) {
            return respondToUploadError(req, res, 'Select at least one audio file to upload.');
        }

        const artistId = String(req.body.artistId ?? '').trim();
        if (artistId) {
            const artistValidation = await validateContentReferences('artist', [artistId]);
            if (!artistValidation.valid) {
                return respondToUploadError(req, res, artistValidation.message!);
            }
        }
        const organizationId = String(req.body.organizationId ?? '').trim();
        if (organizationId) {
            const organizationValidation = await validateContentReferences(
                'organization',
                [organizationId]
            );
            if (!organizationValidation.valid) {
                return respondToUploadError(req, res, organizationValidation.message!);
            }
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return respondToUploadError(req, res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
        }
        const artistRole = String(req.body.artistRole ?? 'primary');
        if (req.body.promoteToAlbumPrimary === 'true'
            && (!albumId || !artistId || artistRole !== 'primary')) {
            return respondToUploadError(
                req,
                res,
                'Album promotion requires a linked Album and Primary Artist role.'
            );
        }
        const attributionUnknown = req.body.attributionUnknown === 'true';
        const inheritsAlbumPrimary = req.body.inheritAlbumPrimaryCredits === 'true'
            && Array.isArray(album?.credits)
            && album.credits.some((credit: any) => credit?.subjectType === 'artist'
                && credit?.role === 'primary');
        const hasProposedCredits = Boolean(artistId || organizationId || inheritsAlbumPrimary);
        if (hasProposedCredits === attributionUnknown) {
            return respondToUploadError(
                req,
                res,
                hasProposedCredits
                    ? 'Attribution cannot be marked undocumented while Credits are selected.'
                    : 'Choose an Artist, Organization, inherited Album Artist, or mark attribution as not documented.'
            );
        }

        const uploadedTrackIds: string[] = [];
        const outcomes: Array<{
            originalFileName: string;
            audioTrackId: string | null;
            uploadStatus: string;
            publicationStatus: string;
            cleanupPending: boolean;
            error: string | null;
        }> = [];
        const cleanupPendingTrackIds: string[] = [];
        let failedCleanupPendingCount = 0;

        for (const uploadFile of uploadFiles) {
            const originalFileName = normalizeUtf8Text(uploadFile.originalname);
            const isAudioFile = uploadFile.mimetype.startsWith('audio/')
                || uploadFile.mimetype === 'video/mp4'
                || uploadFile.mimetype === 'application/ogg';
            if (!isAudioFile) {
                outcomes.push({
                    originalFileName,
                    audioTrackId: null,
                    uploadStatus: 'rejected',
                    publicationStatus: 'notAttempted',
                    cleanupPending: false,
                    error: 'The selected file is not a supported audio type.'
                });
                continue;
            }

            let metadata: any = null;
            try {
                metadata = uploadFile.path
                    ? await parseFile(uploadFile.path, {
                        duration: true,
                        skipCovers: true
                    })
                    : await parseBuffer(Uint8Array.from(uploadFile.buffer), {
                        mimeType: uploadFile.mimetype || undefined,
                        size: uploadFile.size
                    }, {
                        duration: true,
                        skipCovers: true
                    });
            } catch (metadataError) {
                console.log(`Unable to read audio metadata for ${originalFileName}:`, metadataError);
            }

            const embeddedGenres = Array.isArray(metadata?.common?.genre) ? metadata.common.genre.map(String) : [];
            const releaseYear = Number(metadata?.common?.year);
            const bitrate = Number(metadata?.format?.bitrate);
            const audioTrackObjectId = new ObjectId();
            const audioTrackId = audioTrackObjectId.toHexString();
            const credits = proposedSoundtrackCredits(
                audioTrackId,
                album,
                artistId,
                artistRole,
                req.body.inheritAlbumPrimaryCredits === 'true',
                organizationId,
                String(req.body.organizationRole ?? 'label')
            );
            const creditedArtistIds = [...new Set(credits
                .filter((credit) => credit.subjectType === 'artist')
                .map((credit) => credit.subjectId))];
            const metadataTitle = normalizeUtf8Text(String(metadata?.common?.title ?? ''));
            const track = new AudioTrack(
                metadataTitle || titleFromFileName(originalFileName) || 'Untitled Track',
                creditedArtistIds as [string],
                embeddedGenres as unknown as [string],
                albumId,
                Number.isFinite(releaseYear) && releaseYear > 0 ? new SimpleDate(releaseYear, 1, 1) : new SimpleDate(),
                formatDuration(metadata?.format?.duration),
                new AudioFormat(
                    inferAudioFormat(originalFileName, uploadFile.mimetype, metadata?.format?.container),
                    Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : undefined
                ),
                '',
                authReq.auth.userId,
                originalFileName,
                uploadFile.mimetype || 'audio/mpeg',
                audioTrackObjectId
            );
            track.credits = credits;
            track.attributionStatus = attributionUnknown ? 'unknown' : 'documented';
            track.creditRevision = 1;

            try {
                await track.save();
                const upload = await uploadAudioObject(
                    audioTrackId,
                    uploadFile,
                    authReq.auth.userId,
                    getRequestAbortSignal(req)
                );
                uploadedTrackIds.push(audioTrackId);
                if (upload.cleanupPending) cleanupPendingTrackIds.push(audioTrackId);
                outcomes.push({
                    originalFileName,
                    audioTrackId,
                    uploadStatus: 'ready',
                    publicationStatus: 'pending',
                    cleanupPending: upload.cleanupPending,
                    error: null
                });
            } catch (uploadError) {
                console.log(`Unable to upload ${originalFileName}:`, uploadError);
                if ((uploadError as any)?.cleanupPending) failedCleanupPendingCount += 1;
                outcomes.push({
                    originalFileName,
                    audioTrackId,
                    uploadStatus: (uploadError as any)?.outcomeUnknown ? 'unknown' : 'failed',
                    publicationStatus: 'notAttempted',
                    cleanupPending: Boolean((uploadError as any)?.cleanupPending),
                    error: String((uploadError as Error)?.message ?? 'Audio upload failed.').slice(0, 500)
                });
            }
        }

        const publication = uploadedTrackIds.length > 0
            ? await retryAudioTrackPublications(uploadedTrackIds)
            : { requestedCount: 0, readyCount: 0, failedCount: 0, results: [] };
        const publicationById = new Map(
            publication.results.map((result) => [result.audioTrackId, result] as const)
        );
        for (const outcome of outcomes) {
            if (!outcome.audioTrackId || outcome.uploadStatus !== 'ready') continue;
            const result = publicationById.get(outcome.audioTrackId);
            outcome.publicationStatus = result?.publicationStatus ?? 'failed';
            if (result?.outcome !== 'ready') outcome.error = result?.error ?? 'Publication failed.';
        }
        let promotionMessage = '';
        if (req.body.promoteToAlbumPrimary === 'true') {
            const promotedTrack = publication.results.find((result) => result.outcome === 'ready');
            if (promotedTrack) {
                const promotedOwner: any = await AudioTrack.findById(promotedTrack.audioTrackId);
                try {
                    await addSoundtrackCredit(
                        promotedTrack.audioTrackId,
                        {
                            creditId: migratedCatalogCreditId(
                                'audioTrack', promotedTrack.audioTrackId, 'artist', artistId, 'primary'
                            ),
                            subjectType: 'artist',
                            subjectId: artistId,
                            role: 'primary',
                            order: 0
                        },
                        true,
                        Number.isInteger(promotedOwner?.creditRevision)
                            ? promotedOwner.creditRevision
                            : 1
                    );
                } catch (promotionError) {
                    promotionMessage = (promotionError as any)?.outcomeUnknown
                        ? ' Album promotion could not be confirmed; run reconciliation before retrying.'
                        : ' Album promotion did not complete; published Soundtracks remain safely Soundtrack-only and can be promoted from the Credit editor.';
                }
            }
        }
        const cleanupPendingCount = cleanupPendingTrackIds.length + failedCleanupPendingCount;
        const uploadFailureCount = outcomes.filter((outcome) => outcome.uploadStatus !== 'ready').length;
        const publicationFailureCount = publication.failedCount;
        const itemSummary = outcomes
            .filter((outcome) => outcome.audioTrackId)
            .map((outcome) => `${outcome.audioTrackId}: upload=${outcome.uploadStatus}, publication=${outcome.publicationStatus}`)
            .join('; ');
        const message = `${uploadedTrackIds.length} audio track${uploadedTrackIds.length === 1 ? '' : 's'} uploaded; ${publication.readyCount} published.${uploadFailureCount > 0 ? ` ${uploadFailureCount} file${uploadFailureCount === 1 ? '' : 's'} failed upload validation or storage.` : ''}${publicationFailureCount > 0 ? ` ${publicationFailureCount} publication${publicationFailureCount === 1 ? '' : 's'} failed and can be retried without another upload.` : ''}${cleanupPendingCount > 0 ? ` ${cleanupPendingCount} upload${cleanupPendingCount === 1 ? '' : 's'} require storage reconciliation or cleanup.` : ''}${promotionMessage}${itemSummary ? ` ${itemSummary}` : ''}`;
        if (req.get('X-Requested-With') === 'XMLHttpRequest') {
            return res.status(uploadedTrackIds.length > 0 ? 200 : 422).json({
                message,
                uploadedCount: uploadedTrackIds.length,
                publishedCount: publication.readyCount,
                uploadFailureCount,
                publicationFailureCount,
                cleanupPendingCount,
                outcomes
            });
        }
        return redirectWithMessage(res, message);
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [trackValidation, albumValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const album = await Album.findById(albumId);

        if (!track || !album) {
            return redirectWithMessage(res, 'Track or album not found.');
        }

        await linkReadyAudioTracksToAlbum(albumId, [audioTrackId]);

        return redirectWithMessage(res, 'Track linked to album successfully.');
    } catch (error) {
        return next(error);
    }
};

export const linkAlbumToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [albumValidation, artistValidation] = await Promise.all([
            validateContentReferences('album', [albumId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        await ensureAlbumPrimaryArtistCredit(albumId, artistId);
        return redirectWithMessage(res, 'Album primary Artist Credit is linked.');
    } catch (error) {
        return next(error);
    }
};

/** Adds a named Album from the Artist workspace without invoking upload middleware. */
export const addArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const artistId = String(req.body.artistId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [artistValidation, albumValidation] = await Promise.all([
            validateContentReferences('artist', [artistId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        await ensureAlbumPrimaryArtistCredit(albumId, artistId);
        const message = 'Album primary Artist Credit is linked.';
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(message)}#artist-albums`);
    } catch (error) {
        return next(error);
    }
};

/** Removes only the selected Artist membership and preserves the Album record. */
export const removeArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const artistId = String(req.body.artistId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [artistValidation, albumValidation] = await Promise.all([
            validateContentReferences('artist', [artistId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        await removeAlbumPrimaryArtistCredit(albumId, artistId);
        const message = 'Album primary Artist Credit removed. The Album and its Soundtracks were not deleted.';
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(message)}#artist-albums`);
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [trackValidation, artistValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const artist = await Artist.findById(artistId);

        if (!track || !artist) {
            return redirectWithMessage(res, 'Track or artist not found.');
        }

        await addCatalogCredit('audioTrack', audioTrackId, {
            creditId: createCatalogCreditId(),
            subjectType: 'artist',
            subjectId: artistId,
            role: 'legacyUnspecified',
            order: 0
        });

        return redirectWithMessage(res, 'Soundtrack Artist Credit linked successfully.');
    } catch (error) {
        return next(error);
    }
};

export const searchContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawQuery = boundedSearchQuery(req.query.q);
        if (!rawQuery) {
            return res.status(400).json({ message: 'Missing required query parameter: q' });
        }

        const limit = boundedLimit(req.query.limit, 10, 50);

        return res.status(200).json(await searchPublicCatalog(rawQuery, limit));
    } catch (error) {
        return next(error);
    }
};

/** Returns an allowlisted legacy-client Organization detail envelope. */
export const getOrganization = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await getPublicOrganization(String(req.params.organizationId ?? ''));
        if (!result) return res.status(404).json({ message: 'Organization not found.' });
        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
};
