import { escapeHtml } from '../html';
import type { S3StorageSummary } from '../../services/s3StorageService';
import { formatStorageSize } from '../../utils/storageSize';
import { activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import { renderPageItemsHierarchy } from './pageItemsView';
import { renderReleaseOperations } from './releaseOperationsView';
import type { ArtistReleaseWorkflowResult } from '../../services/artistReleaseWorkflowService';
import {
    InventoryKey,
    InventoryPagination,
    CatalogSection,
    inventoryQueryNames,
    ManagerView,
    catalogSectionForSelection
} from './managementNavigation';
import { contentId, uniqueStrings } from '../../utils/catalogValues';

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

const renderInventoryPagination = (
    key: InventoryKey,
    label: string,
    pagination: InventoryPagination,
    catalogSection: CatalogSection
) => {
    const state = pagination[key];
    if (!state.hasPrevious && !state.hasNext) return '';
    const linkFor = (page: number) => {
        const query = new URLSearchParams();
        query.set('view', 'catalog');
        query.set('catalogType', catalogSection);
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
    if (items.length === 0) return '';
    const content = items.map((item) => `<li>${formatter(item)}</li>`).join('');
    return `<section class="catalog-search-result-group"><h3>${escapeHtml(title)}</h3><ul>${content}</ul></section>`;
};

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

/** Keeps relationship detail available without expanding every nested record by default. */
const renderNestedList = (items: string[], summary: string, footer: string = '') => {
    return items.length > 0
        ? `<details class="linked-content-disclosure"><summary>${escapeHtml(summary)}</summary><ul class="linked-content">${items.map((item) => `<li>${item}</li>`).join('')}</ul>${footer}</details>`
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

export const organizationCreditRoleOptions = [
    ['label', 'Label'],
    ['publisher', 'Publisher'],
    ['distributor', 'Distributor'],
    ['presenter', 'Presenter']
];

export const soundtrackParticipantRoleOptions = [
    ['primary', 'Primary Artist'],
    ['featured', 'Featured Artist'],
    ['performer', 'Performer'],
    ['composer', 'Composer'],
    ['producer', 'Producer'],
    ['remixer', 'Remixer']
];

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
            return ownerType === 'album' ? 'Organization Releases' : 'MediaTrack attribution';
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
            return `<li><span><strong>${escapeHtml(label)}</strong>, position ${index + 1}<small class="placement-preview">Public placement: ${escapeHtml(placementFor(credit))}</small></span><form method="POST" action="/content/manage/credits/update-role">${hidden}<label>Role<select name="role">${roleSelect}</select></label><button class="button--secondary" type="submit">Update Role</button></form><form method="POST" action="/content/manage/credits/reorder">${hidden}<button class="button--secondary" name="direction" value="up" type="submit"${index === 0 ? ' disabled' : ''}>Move Up</button><button class="button--secondary" name="direction" value="down" type="submit"${index === credits.length - 1 ? ' disabled' : ''}>Move Down</button></form><form method="POST" action="/content/manage/credits/remove">${hidden}<button class="button--secondary" type="submit">Remove Credit</button></form></li>`;
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
        ? '<label><input type="checkbox" name="promoteToAlbumPrimary" value="true" /> If this is a primary Credit, also add the Artist as an Album primary Credit</label><p class="drag-help">Off by default. Featured and performer Credits always stay MediaTrack-only.</p>'
        : ''}
      <button type="submit" data-reference-submit disabled>Add Credit</button>
    </form>`;
    return `<section class="credit-editor"><h3>Credits</h3><p class="muted">Credits control public attribution. A MediaTrack participant is not silently promoted to an Album primary Artist.</p>${creditItems}<details><summary>Add Artist Credit</summary>${addForm('artist', artistCreditRoleOptions)}</details><details><summary>Add Organization Credit</summary>${addForm('organization', organizationCreditRoleOptions)}</details><form method="POST" action="/content/manage/credits/mark-unknown" data-confirm-attribution-unknown><input type="hidden" name="ownerType" value="${ownerType}" /><input type="hidden" name="ownerId" value="${escapeHtml(ownerId)}" /><button class="button--secondary" type="submit">Mark attribution as not documented</button></form></section>`;
};

/** Renders already-resolved management data; it never loads inventory or mutates content. */
export const renderManagePage = (params: {
    userId: string;
    userEmail: string;
    maxAudioBatchFiles: number;
    organizationTypes: readonly string[];
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
    catalogSection?: CatalogSection;
}) => {
    const { maxAudioBatchFiles, organizationTypes } = params;
    const messageBlock = params.message
        ? `<div class="alert" role="status">${escapeHtml(params.message)}</div>`
        : '';

    const hasSearchQuery = Boolean(String(params.searchQuery ?? '').trim());
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
            ? ', Artist'
            : carousel.mode === 'personalized' ? ', Personalized' : '';
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
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(organization.name ?? 'Untitled organization'))}, ${escapeHtml(type)}</option>`;
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
        ? `<input type="hidden" name="organizationId" value="${escapeHtml(prefillOrganizationId)}" /><p class="muted">Editing <strong>${escapeHtml(String(prefillOrganization.name ?? 'Organization'))}</strong>. <a href="/content/manage?view=catalog&amp;catalogType=organizations#catalog-content">Choose another</a></p>`
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
    const activeCatalogSection = catalogSectionForSelection(selectedType)
        ?? params.catalogSection
        ?? 'artists';
    const paginationFor = (key: InventoryKey, label: string) => inventoryPagination
        ? renderInventoryPagination(key, label, inventoryPagination, activeCatalogSection)
        : '';
    const catalogSectionDetails: Array<{
        key: CatalogSection;
        label: string;
        description: string;
        count: number;
    }> = [
        { key: 'artists', label: 'Artists', description: 'People and creative groups with their linked releases.', count: catalogArtists.length },
        { key: 'organizations', label: 'Organizations', description: 'Labels, publishers, distributors, and other institutional Credits.', count: catalogOrganizations.length },
        { key: 'albums', label: 'Albums', description: 'Releases with MediaTrack membership and attribution.', count: catalogAlbums.length },
        { key: 'audioTracks', label: 'MediaTracks', description: 'Playable Audio and Video catalog records.', count: catalogAudioTracks.length },
        { key: 'pages', label: 'Pages', description: 'Public destinations and their configured presentation items.', count: catalogPages.length },
        { key: 'carousels', label: 'Carousels', description: 'Manual, Artist-driven, and personalized horizontal collections.', count: catalogCarousels.length },
        { key: 'contentCollections', label: 'Collections', description: 'Grid and List definitions used by public Pages.', count: catalogContentCollections.length }
    ];
    const activeCatalogDetails = catalogSectionDetails.find(({ key }) => key === activeCatalogSection)!;
    const catalogSectionNav = catalogSectionDetails.map(({ key, label, count }) => {
        const query = new URLSearchParams({ view: 'catalog', catalogType: key });
        return `<a href="/content/manage?${escapeHtml(query.toString())}#catalog-content"${key === activeCatalogSection ? ' aria-current="page"' : ''}><span>${escapeHtml(label)}</span><span class="catalog-type-count">${count}</span></a>`;
    }).join('');
    const selectedId = prefillArtistId || prefillAlbumId || prefillAudioTrackId || prefillOrganizationId;
    const selectedLabel = prefillArtist
        ? String(prefillArtist.name ?? 'Artist')
        : prefillAlbum
            ? String(prefillAlbum.title ?? 'Album')
            : prefillAudioTrack
                ? String(prefillAudioTrack.title ?? 'MediaTrack')
                : prefillOrganization ? String(prefillOrganization.name ?? 'Organization') : '';
    const selectedTypeLabel = selectedType === 'audioTrack'
        ? 'MediaTrack'
        : selectedType === 'none' ? '' : `${selectedType[0].toUpperCase()}${selectedType.slice(1)}`;
    const catalogReturnUrl = `/content/manage?view=catalog&amp;catalogType=${encodeURIComponent(activeCatalogSection)}#catalog-content`;
    const selectedObjectBlock = selectedType === 'none'
        ? ''
        : `<section class="card selected-object surface-catalog" id="selected-object" aria-labelledby="selected-object-title"><div><p class="eyebrow">Selected ${escapeHtml(selectedTypeLabel)}</p><h2 id="selected-object-title">${escapeHtml(selectedLabel)}</h2><p class="muted">Edit this object below. Return to its focused inventory when you are finished.</p></div><div class="action-row"><button class="button button--secondary" type="button" data-copy-id="${escapeHtml(selectedId)}">Copy ID</button><a class="button button--secondary" href="${catalogReturnUrl}">Back to ${escapeHtml(activeCatalogDetails.label)}</a></div></section>`;
    const openByIdBlock = selectedType === 'none'
        && ['artists', 'organizations', 'albums', 'audioTracks'].includes(activeCatalogSection)
        ? `<details class="card catalog-tool-group surface-catalog" id="open-by-id"><summary><span><strong>Open by ID</strong><small>Use a canonical ID when search is not enough.</small></span></summary><div class="catalog-tool-group__body"><form method="GET" action="/content/manage"><input type="hidden" name="view" value="catalog" /><label>Content type<select name="prefillType"><option value="artist"${activeCatalogSection === 'artists' ? ' selected' : ''}>Artist</option><option value="organization"${activeCatalogSection === 'organizations' ? ' selected' : ''}>Organization</option><option value="album"${activeCatalogSection === 'albums' ? ' selected' : ''}>Album</option><option value="audioTrack"${activeCatalogSection === 'audioTracks' ? ' selected' : ''}>MediaTrack</option></select></label><label>Canonical ID<input name="prefillId" autocomplete="off" required /></label><button type="submit">Open item</button></form></div></details>`
        : '';
    const catalogCreationCopy: Partial<Record<CatalogSection, { title: string; description: string }>> = {
        artists: { title: 'Create Artist', description: 'Add a person or creative group to the global catalog.' },
        organizations: { title: 'Create Organization', description: 'Add a label, publisher, distributor, or other institution.' },
        albums: { title: 'Create Album', description: 'Create a release now; MediaTracks and Credits can be linked afterward.' },
        audioTracks: { title: 'Create MediaTrack', description: 'Upload one Audio or MP4 Video object with its catalog metadata.' }
    };
    const catalogCreation = catalogCreationCopy[activeCatalogSection];
    const catalogSearchSections = [
        renderSectionList('Artists', artists, (item) => renderReferencedItem(item, String(item.name ?? ''), 'artist')),
        renderSectionList('Organizations', organizations, (item) => renderReferencedItem(item, String(item.name ?? ''), 'organization')),
        renderSectionList('Albums', albums, (item) => renderReferencedItem(item, String(item.title ?? ''), 'album')),
        renderSectionList('MediaTracks', audioTracks, (item) => renderReferencedItem(item, String(item.title ?? ''), 'audioTrack'))
    ].join('');
    const catalogSearchContent = catalogSearchSections
        || '<p class="empty-linked-content">No matching catalog content.</p>';
    const bulkAudioUploadBlock = `<details class="advanced-tools" id="bulk-audio-upload">
      <summary>Bulk upload Audio MediaTracks</summary>
      <p id="bulk-audio-file-limit">Select up to ${maxAudioBatchFiles} files. Files are uploaded one at a time so each request remains within the 1 GiB request boundary.</p>
      <form id="bulk-audio-upload-form" data-max-files="${maxAudioBatchFiles}" method="POST" action="/content/manage/audioTrack/bulk-upload" enctype="multipart/form-data">
        <select name="artistId"><option value="">No Artist Credit</option>${artistOptions}</select>
        <select name="artistRole">${renderCreditRoleOptions(soundtrackParticipantRoleOptions)}</select>
        <select name="organizationId"><option value="">No Organization Credit</option>${organizationOptions}</select>
        <select name="organizationRole">${renderCreditRoleOptions(organizationCreditRoleOptions)}</select>
        <select name="albumId"><option value="">No album</option>${albumOptions}</select>
        <label><input type="checkbox" name="inheritAlbumPrimaryCredits" value="true" checked /> Inherit the selected Album's primary Artists</label>
        <label><input type="checkbox" name="attributionUnknown" value="true" /> Attribution is not documented</label>
        <label><input type="checkbox" name="promoteToAlbumPrimary" value="true" aria-describedby="bulk-album-promotion-help" /> If the selected Primary Artist is not already on the Album, also add them</label>
        <small id="bulk-album-promotion-help">Available only when an Album and Primary Artist are selected.</small>
        <input type="file" name="audioFiles" accept="audio/*" multiple required aria-describedby="bulk-audio-file-limit" />
        <button type="submit">Create and Upload Audio MediaTracks</button>
        <div id="bulk-upload-status" role="status" aria-live="polite" hidden><progress id="bulk-upload-progress" max="100" value="0">0%</progress><span id="bulk-upload-progress-label">0%</span></div>
      </form>
    </details>`;
    const releaseOperationsBlock = renderReleaseOperations(releaseOperations);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Content Manager</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <link rel="stylesheet" href="/assets/content-manager-base.css" />
  <link rel="stylesheet" href="/assets/content-manager.css" />
</head>
<body class="manager-page manager-view-${managerView} manager-selection-${selectedType} catalog-section-${activeCatalogSection}">
  <main class="page-shell">
  <header class="site-header">
    <div>
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><i class="ph ph-tree-structure"></i></span><span>Archtree</span></a>
      <p class="eyebrow" style="margin-top:18px;">Catalog workspace</p>
      <h1 style="margin-bottom:8px;">Content Manager</h1>
    </div>
    <details class="manager-account" id="manager-account-menu">
      <summary><i class="ph ph-user-circle" aria-hidden="true"></i>Admin account</summary>
      <div class="manager-account__panel">
        <p class="eyebrow">Signed in</p>
        <strong>${escapeHtml(params.userEmail)}</strong>
        <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(params.userId)}" /><button class="button--secondary" type="submit"><i class="ph ph-sign-out" aria-hidden="true"></i>Log out</button></form>
      </div>
    </details>
  </header>
  ${messageBlock}
  <section class="card upload-results surface-operations" id="bulk-upload-results" role="status" aria-live="polite" hidden>
    <h2>Upload results</h2>
    <div class="upload-results__grid"></div>
  </section>
  ${s3StorageBlock}
  <nav class="manager-nav" aria-label="Content Manager sections">
    <a href="/content/manage?view=overview"${managerView === 'overview' ? ' aria-current="page"' : ''}><i class="ph ph-house-simple" aria-hidden="true"></i>Overview</a>
    <a href="/content/manage?view=catalog"${managerView === 'catalog' ? ' aria-current="page"' : ''}><i class="ph ph-stack" aria-hidden="true"></i>Catalog</a>
    <a href="/content/manage?view=layout"${managerView === 'layout' ? ' aria-current="page"' : ''}><i class="ph ph-files" aria-hidden="true"></i>Page Layout</a>
    <a href="/content/manage?view=operations"${managerView === 'operations' ? ' aria-current="page"' : ''}><i class="ph ph-gear-six" aria-hidden="true"></i>Operations</a>
  </nav>

  <section class="card surface-operations" id="system-operations" aria-labelledby="system-operations-title">
    <p class="eyebrow">Administrative tools</p>
    <h2 id="system-operations-title">System operations</h2>
    <p class="muted">Open focused maintenance workspaces without competing with everyday catalog navigation.</p>
    <nav class="operations-tool-grid" aria-label="System operation destinations">
      <a class="operations-tool" href="/content/manage/audio-tracks"><i class="ph ph-waveform" aria-hidden="true"></i><strong>MediaTrack operations</strong><span>Filter the global inventory and review publication or storage status.</span></a>
      ${params.isAdmin ? '<a class="operations-tool" href="/admin/audio-storage/reconciliation"><i class="ph ph-database" aria-hidden="true"></i><strong>Audio storage audit</strong><span>Review reconciliation findings and explicitly confirm any remediation.</span></a><a class="operations-tool" href="/admin/image-storage/reconciliation"><i class="ph ph-image" aria-hidden="true"></i><strong>Image storage audit</strong><span>Inspect catalog artwork and avatar lifecycle discrepancies.</span></a>' : ''}
    </nav>
  </section>

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
          <label>Sort<select name="carouselSort"><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A-Z</option></select></label>
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

  <section class="card catalog-browser surface-catalog" id="catalog-content" aria-labelledby="catalog-content-title">
    <div class="catalog-browser__header">
      <div><p class="eyebrow">Global inventory</p><h2 id="catalog-content-title">Catalog</h2><p class="muted">Choose one content type, then search, review, create, or edit in context.</p></div>
      <form class="catalog-search-form" method="GET" action="/content/manage/search" role="search">
        <input type="hidden" name="catalogType" value="${activeCatalogSection}" />
        <label>Search all catalog content<input type="search" name="q" value="${searchQuery}" placeholder="Artist, organization, album, or MediaTrack" required /></label>
        <button type="submit">Search</button>
      </form>
    </div>
    <nav class="catalog-type-nav" aria-label="Catalog content types">${catalogSectionNav}</nav>
    <div class="catalog-active-heading">
      <div><p class="eyebrow">Current view</p><h2>${escapeHtml(activeCatalogDetails.label)}</h2><p class="muted">${escapeHtml(activeCatalogDetails.description)} ${activeCatalogDetails.count} shown on this page.</p></div>
      ${['pages', 'carousels', 'contentCollections'].includes(activeCatalogSection) ? '<a class="button button--secondary" href="/content/manage?view=layout">Manage Page Layout</a>' : ''}
    </div>
  </section>
  ${hasSearchQuery ? `<section class="card catalog-search-results surface-catalog" aria-labelledby="catalog-search-results-title"><p class="eyebrow">Search results</p><h2 id="catalog-search-results-title">Matches for “${searchQuery}”</h2><div class="catalog-search-results__grid">${catalogSearchContent}</div></section>` : ''}
  ${selectedObjectBlock}

  ${selectedType === 'none' ? `<div class="card catalog-inventory-card surface-catalog" id="catalog-inventory">
    ${activeCatalogSection === 'artists' ? `<section id="inventory-artists">
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

          const relationshipLabel = `${linkedAlbumIds.length} linked album${linkedAlbumIds.length === 1 ? '' : 's'}`;
          return `<div class="hierarchy-item"><strong>${renderReferencedItem(artist, String(artist.name ?? ''), 'artist')}</strong>${renderNestedList(linkedAlbums, relationshipLabel)}</div>`;
      }).join('') : '<p class="empty-linked-content">No artists yet.</p>'}
    </div>
    ${paginationFor('artists', 'Artists')}
    </section>` : ''}

    ${activeCatalogSection === 'organizations' ? `<section id="inventory-organizations">
      <h3>Organizations</h3>
      <div class="content-hierarchy">
        ${catalogOrganizations.length > 0 ? catalogOrganizations.map((organization) => {
            const organizationId = contentId(organization);
            const creditedAlbums = catalogAlbums.filter((album) => (Array.isArray(album.credits) ? album.credits : [])
                .some((credit: any) => credit?.subjectType === 'organization' && String(credit.subjectId ?? '') === organizationId));
            const releaseLabel = `${creditedAlbums.length} release${creditedAlbums.length === 1 ? '' : 's'} on this page`;
            return `<div class="hierarchy-item"><strong>${renderReferencedItem(organization, String(organization.name ?? ''), 'organization')}</strong><span class="item-meta">${escapeHtml(String(organization.organizationType ?? 'other'))}</span>${renderNestedList(creditedAlbums.map((album) => renderReferencedItem(album, String(album.title ?? ''), 'album')), releaseLabel)}</div>`;
        }).join('') : '<p class="empty-linked-content">No organizations yet.</p>'}
      </div>
      ${paginationFor('organizations', 'Organizations')}
    </section>` : ''}

    ${activeCatalogSection === 'albums' ? `<section id="inventory-albums">
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

              return `<label class="track-selection"><input type="checkbox" name="audioTrackIds" value="${escapeHtml(trackId)}" aria-label="Select ${escapeHtml(String(track.title ?? 'MediaTrack'))}" />${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</label>`;
          });
          const selectableTrackCount = linkedTrackIds.filter((trackId) => tracksById.has(trackId)).length;

          const relationshipLabel = `${linkedTrackIds.length} linked MediaTrack${linkedTrackIds.length === 1 ? '' : 's'}`;
          const batchActions = selectableTrackCount > 0 ? '<div class="batch-track-actions"><button class="select-all-tracks button--secondary" type="button">Select all</button><button class="batch-delete-button" data-danger type="submit" disabled>Delete selected MediaTracks</button></div>' : '';
          return `<form class="hierarchy-item" data-batch-track-delete method="POST" action="/content/manage/album/delete-audio-tracks"><input type="hidden" name="albumId" value="${escapeHtml(albumId)}" /><strong>${renderReferencedItem(album, String(album.title ?? ''), 'album')}</strong>${renderNestedList(linkedTracks, relationshipLabel, batchActions)}</form>`;
      }).join('') : '<p class="empty-linked-content">No albums yet.</p>'}
    </div>
    ${paginationFor('albums', 'Albums')}
    </section>` : ''}

        ${activeCatalogSection === 'audioTracks' ? `<section id="inventory-audioTracks">
          <h3>MediaTracks</h3>
          <div class="content-hierarchy">
            ${catalogAudioTracks.length > 0 ? catalogAudioTracks.map((track) => `<div class="hierarchy-item"><strong>${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</strong><span>${escapeHtml(String(track.uploadStatus ?? 'legacy'))}</span></div>`).join('') : '<p class="empty-linked-content">No MediaTracks yet.</p>'}
          </div>
          ${paginationFor('audioTracks', 'MediaTracks')}
        </section>` : ''}

        ${activeCatalogSection === 'pages' ? `<section id="inventory-pages">
          ${renderPageItemsHierarchy(catalogPages, catalogCarousels, catalogContentCollections)}
          ${paginationFor('pages', 'Pages')}
        </section>` : ''}

        ${activeCatalogSection === 'carousels' ? `<section id="inventory-carousels">
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
                  ? `<span class="pill">Dynamic</span> <span>${escapeHtml(artistName)}, ${carousel.artistConfig?.contentType === 'album' ? 'Albums' : 'MediaTracks'}</span>`
                  : isPersonalizedCarousel
                      ? `<span class="pill">Personalized</span> <span>${carousel.personalizedConfig?.source === 'recentlyPlayed' ? 'Recently Played' : 'Recently Saved'}, mixed content</span>`
                  : '<span class="pill pill--muted">Manual</span>';
              const itemLabel = `${items.length} configured item${items.length === 1 ? '' : 's'}`;
              return `<div class="hierarchy-item"><strong>${renderReferencedItem(carousel, String(carousel.name ?? ''))}</strong><div class="item-meta">${dynamicSummary}</div>${renderNestedList(carouselItems, itemLabel)}</div>`;
          }).join('') : '<p class="empty-linked-content">No carousels yet.</p>'}
        </div>
        ${paginationFor('carousels', 'Carousels')}
        </section>` : ''}

        ${activeCatalogSection === 'contentCollections' ? `<section id="inventory-contentCollections">
          <h3>Content Collections</h3>
          <div class="content-hierarchy">
            ${catalogContentCollections.length > 0 ? catalogContentCollections.map((collection) => {
                const presentation = String(collection.presentation ?? 'collection');
                const mode = collection.mode === 'dynamic' ? 'Dynamic' : 'Manual';
                return `<div class="hierarchy-item"><strong>${renderReferencedItem(collection, String(collection.name ?? 'Untitled collection'))}</strong><span>${escapeHtml(presentation)}, ${mode}</span></div>`;
            }).join('') : '<p class="empty-linked-content">No content collections yet.</p>'}
          </div>
          ${paginationFor('contentCollections', 'Content Collections')}
        </section>` : ''}
  </div>` : ''}

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
                    <select name="artistContentType"><option value="album">Albums</option><option value="audioTrack">MediaTracks</option></select>
                    <select name="artistScope"><option value="discography">Discography / primary</option><option value="collaborations">Collaborations / featured</option><option value="appearsOn">Appears On / performer</option><option value="allRelated">All related credits</option></select>
                    <select name="artistSort"><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A-Z</option></select>
                    <input name="artistLimit" type="number" min="1" max="100" value="20" />
                    <p class="drag-help">Items are generated automatically from the selected artist and cannot be manually reordered.</p>
                </div>
                <div class="personalized-carousel-config stack" hidden>
                    <select name="personalizedSource"><option value="recentlySaved">Recently Saved</option><option value="recentlyPlayed">Recently Played</option></select>
                    <input name="personalizedLimit" type="number" min="1" max="20" value="20" />
                    <p class="drag-help">Albums and MediaTracks are mixed automatically for the signed-in viewer.</p>
                </div>
                <button type="submit">Create Carousel</button>
            </form>

            <h3>Update Artist Carousel</h3>
            <form class="update-artist-carousel" method="POST" action="/content/manage/composition/carousel/update-artist">
                <select class="artist-carousel-selector" name="carouselId" required><option value="" disabled selected>Select artist carousel</option>${artistCarouselOptions}</select>
                <input name="name" placeholder="Carousel name" required />
                <select name="artistId" required><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                <select name="artistContentType" required><option value="album">Albums</option><option value="audioTrack">MediaTracks</option></select>
                <select name="artistScope" required><option value="discography">Discography / primary</option><option value="collaborations">Collaborations / featured</option><option value="appearsOn">Appears On / performer</option><option value="allRelated">All related credits</option></select>
                <select name="artistSort" required><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A-Z</option></select>
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
                <select name="contentType" required><option value="" disabled selected>Select content type</option><option value="post">Post</option><option value="album">Album</option><option value="audioTrack">MediaTrack</option></select>
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

  ${(catalogCreation && selectedType === 'none') || prefillOrganization ? `<details class="card catalog-tool-group surface-catalog" id="create"${prefillOrganization ? ' open' : ''}>
    <summary><span><strong>${prefillOrganization ? 'Organization workspace' : escapeHtml(catalogCreation?.title ?? 'Create')}</strong><small>${prefillOrganization ? 'Update this Organization or create an institutional release.' : escapeHtml(catalogCreation?.description ?? '')}</small></span></summary>
    <div class="catalog-tool-group__body"><div class="grid" id="catalog-create-tools">
    <div class="card create-card create-card--artists">
      <h3>Create Artist</h3>
      <form method="POST" action="/content/manage/artist/create" enctype="multipart/form-data">
        <label>Name<input name="name" required /></label>
        <label>Birth date<input name="birthDate" type="date" /></label>
        <label>Biography<textarea name="bio" rows="3"></textarea></label>
        <label>Cover art (optional)<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
        <label>Album IDs (optional)<input name="albumIds" placeholder="Comma separated canonical IDs" /></label>
        <button type="submit">Create Artist</button>
      </form>
    </div>

    <div class="card create-card create-card--albums">
      <h3>Create Album</h3>
      <form method="POST" action="/content/manage/album/create" enctype="multipart/form-data">
        <label>Title<input name="title" required /></label>
        <label>Cover art (optional)<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
        <label>MediaTrack membership IDs (optional)<input name="audioTrackIds" placeholder="Comma separated canonical IDs" /></label>
        <p class="drag-help">Album order is derived from each file's embedded Track Number and cannot be arranged manually.</p>
        <label>Release date<input name="releaseDate" type="date" /></label>
        <button type="submit">Create Album</button>
      </form>
    </div>

    <div class="card create-card create-card--audioTracks">
      <h3>Create and Upload MediaTrack</h3>
      <form method="POST" action="/content/manage/audioTrack/create" enctype="multipart/form-data">
        <label>Title<input name="title" required /></label>
        <label>Artist Credit<select name="artistId"><option value="">No Artist Credit</option>${artistOptions}</select></label>
        <label>Artist role<select name="artistRole">${renderCreditRoleOptions(soundtrackParticipantRoleOptions)}</select></label>
        <label>Organization Credit<select name="organizationId"><option value="">No Organization Credit</option>${organizationOptions}</select></label>
        <label>Organization role<select name="organizationRole">${renderCreditRoleOptions(organizationCreditRoleOptions)}</select></label>
        <label>Genres<input name="genres" placeholder="Comma separated" /></label>
        <label>Album<select name="albumId"><option value="">No album</option>${albumOptions}</select></label>
        <label><input type="checkbox" name="inheritAlbumPrimaryCredits" value="true" checked /> Inherit the selected Album's primary Artists</label>
        <label><input type="checkbox" name="attributionUnknown" value="true" /> Attribution is not documented</label>
        <label><input type="checkbox" name="promoteToAlbumPrimary" value="true" /> If the selected participant is primary, also add them to the Album</label>
        <p class="drag-help">Choose an Artist, an Organization, inherited Album Artists, or explicitly mark attribution as not documented. Album promotion is off by default.</p>
        <label>Release date<input name="releaseDate" type="date" /></label>
        <label>Duration<input name="duration" placeholder="For example 03:30" /></label>
        <label>Format type<input name="formatType" placeholder="For example MP3 or MP4" /></label>
        <label>Bitrate (optional)<input name="formatBitrate" /></label>
        <label>Cover art (optional)<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
        <label>Audio or MP4 Video<input type="file" name="mediaFile" accept="audio/*,video/mp4" required /></label>
        <button type="submit">Create and Upload MediaTrack</button>
      </form>
      ${bulkAudioUploadBlock}
    </div>

    <div class="card create-card create-card--organizations object-workspace object-workspace--organization" id="organization-workspace">
      ${prefillOrganization
        ? '<h3>Organization workspace</h3><p class="muted">Update this Organization, create an institutional release, or remove it when no content still references it.</p>'
        : `<h3>Create Organization</h3>
          <p class="muted">Use this for a label, publisher, distributor, archive, broadcaster, studio, or other institution. Do not create it as an Artist.</p>
          <form method="POST" action="/content/manage/organization/create">
            <label>Name<input name="name" required maxlength="200" /></label>
            <label>Type<select name="organizationType">${organizationTypes.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label>
            <label>Description<textarea name="description" rows="3"></textarea></label>
            <button type="submit">Create Organization</button>
          </form>`}
      <details${prefillOrganization ? ' open' : ''}><summary>${prefillOrganization ? 'Update Organization details' : 'Update an Organization'}</summary>
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
        <p class="muted">Deletion is blocked while any Album or MediaTrack still credits the Organization.</p>
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
  </div></div></details>` : ''}

    ${selectedType === 'none' && ['artists', 'albums', 'audioTracks'].includes(activeCatalogSection) ? `<details class="card catalog-tool-group surface-catalog" id="quick-linking">
      <summary><span><strong>Advanced relationship tools</strong><small>Use canonical IDs only for exceptional linking or migration work.</small></span></summary>
      <div class="catalog-tool-group__body"><div class="grid" id="catalog-quick-linking-tools">
        <div class="card quick-link--track-album">
            <h3>Link Track to Album</h3>
            <form method="POST" action="/content/manage/link/track-album">
                <label>MediaTrack ID<input name="audioTrackId" required /></label>
                <label>Album ID<input name="albumId" required /></label>
                <button type="submit">Link Track and Album</button>
            </form>
            <p>Sets track.albumId and ensures album.audioTrackIds contains the track.</p>
        </div>

        <div class="card quick-link--album-artist">
            <h3>Link Album to Artist</h3>
            <form method="POST" action="/content/manage/link/album-artist">
                <label>Album ID<input name="albumId" required /></label>
                <label>Artist ID<input name="artistId" required /></label>
                <button type="submit">Link Album and Artist</button>
            </form>
            <p>Adds albumId into artist.albumIds if missing.</p>
        </div>

        <div class="card quick-link--track-artist">
            <h3>Link Track to Artist</h3>
            <form method="POST" action="/content/manage/link/track-artist">
                <label>MediaTrack ID<input name="audioTrackId" required /></label>
                <label>Artist ID<input name="artistId" required /></label>
                <button type="submit">Link Track and Artist</button>
            </form>
            <p>Adds artistId to track.artistIds. Tracks are the source of truth for artist relationships.</p>
        </div>
      </div></div>
    </details>` : ''}

    ${openByIdBlock}

    ${selectedType !== 'none' && selectedType !== 'organization' ? `<div class="section-heading surface-catalog" id="update-delete"><div><p class="eyebrow">Editing workspace</p><h2>Edit ${escapeHtml(selectedTypeLabel)}</h2></div></div>
  <div class="grid surface-catalog object-workspaces" id="catalog-object-workspaces">
        <div class="card object-workspace object-workspace--artist" id="artist-update-card">
      <h3>Artist workspace</h3>
      ${prefillArtist
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillArtist.name ?? 'Artist'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillArtistId}">Copy ID</button><a href="${catalogReturnUrl}">Choose another Artist</a></div>`
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
                <label>Replacement cover art<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
        <button type="submit">Update Cover Art</button>
      </form>
      <hr />
      <section id="artist-albums">
        <h3>Albums</h3>
        <p class="muted">Add or remove memberships here. Removing a membership does not delete the Album or its MediaTracks.</p>
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
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillAlbum.title ?? 'Album'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillAlbumId}">Copy ID</button><a href="${catalogReturnUrl}">Choose another Album</a></div>`
        : `<p class="muted">Choose Edit from the Album inventory, or load a known ID.</p><form method="GET" action="/content/manage#album-update-card">
                <input type="hidden" name="prefillType" value="album" />
                <input name="prefillId" value="${prefillAlbumId}" placeholder="Album ID" required />
                <button type="submit">Load Current</button>
            </form>`}
      ${prefillAlbum ? `<section class="workspace-section" aria-labelledby="album-details-heading"><h3 id="album-details-heading">Details and media</h3><form method="POST" action="/content/manage/album/update" enctype="multipart/form-data">
                <input type="hidden" name="albumId" value="${prefillAlbumId}" required />
                <label>Title<input name="title" value="${escapeHtml(String(prefillAlbum?.title ?? ''))}" /></label>
                <label>Replacement cover art<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
                <label>MediaTrack membership IDs<input name="audioTrackIds" value="${escapeHtml(toCsvInput(prefillAlbum?.audioTrackIds))}" placeholder="Comma separated canonical IDs" /></label>
                <p class="drag-help">Membership can be changed here; order always comes from each file's embedded Track Number.</p>
                <label>Release date<input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAlbum?.releaseDate))}" type="date" /></label>
        <button type="submit">Update Album</button>
      </form></section>
      <section class="workspace-section">${renderCreditEditor('album', prefillAlbumId, prefillAlbum, prefillCreditSubjectLabels)}</section>
      <section class="card danger-zone workspace-section" aria-labelledby="delete-album-heading"><h3 id="delete-album-heading">Danger zone</h3><p>Deletion keeps lifecycle evidence until every owned media object is safely cleaned up.</p><form method="POST" action="/content/manage/album/delete"><input type="hidden" name="albumId" value="${prefillAlbumId}" required /><button data-danger type="submit">Delete Album</button></form></section>` : '<p class="empty-linked-content">No Album selected.</p>'}
    </div>

        <div class="card object-workspace object-workspace--audioTrack" id="audio-track-update-card">
      <h3>MediaTrack</h3>
      ${prefillAudioTrack
        ? `<div class="workspace-context"><p><strong>${escapeHtml(String(prefillAudioTrack.title ?? 'MediaTrack'))}</strong></p><button class="copy-id" type="button" data-copy-id="${prefillAudioTrackId}">Copy ID</button><a href="${catalogReturnUrl}">Choose another MediaTrack</a></div>`
        : `<p class="muted">Choose Edit from the MediaTrack inventory, or load a known ID.</p><form method="GET" action="/content/manage#audio-track-update-card">
                <input type="hidden" name="prefillType" value="audioTrack" />
                <input name="prefillId" value="${prefillAudioTrackId}" placeholder="MediaTrack ID" required />
                <button type="submit">Load Current</button>
            </form>`}
      ${prefillAudioTrack ? `<section class="workspace-section" aria-labelledby="soundtrack-details-heading"><h3 id="soundtrack-details-heading">Details and cover art</h3><form method="POST" action="/content/manage/audioTrack/update" enctype="multipart/form-data">
                <input type="hidden" name="audioTrackId" value="${prefillAudioTrackId}" required />
                <label>Title<input name="title" value="${escapeHtml(String(prefillAudioTrack?.title ?? ''))}" /></label>
                <label>Replacement cover art<input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" /></label>
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
                <label>Artist IDs<input name="artistIds" value="${escapeHtml(toCsvInput(prefillAudioTrack?.artistIds))}" placeholder="Comma separated canonical IDs" /></label>
                <label>Genres<input name="genres" value="${escapeHtml(toCsvInput(prefillAudioTrack?.genres))}" placeholder="Comma separated" /></label>
                <label>Album ID<input name="albumId" value="${escapeHtml(String(prefillAudioTrack?.albumId ?? ''))}" /></label>
                <label>Release date<input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAudioTrack?.releaseDate))}" type="date" /></label>
                <label>Duration<input name="duration" value="${escapeHtml(String(prefillAudioTrack?.duration ?? ''))}" placeholder="For example 03:30" /></label>
                <label>Format type<input name="formatType" value="${escapeHtml(String(prefillAudioTrack?.format?.type ?? ''))}" placeholder="For example MP3" /></label>
                <label>Bitrate<input name="formatBitrate" value="${escapeHtml(String(prefillAudioTrack?.format?.bitrate ?? ''))}" placeholder="For example 320" /></label>
        <button type="submit">Update MediaTrack</button>
      </form></section>
      <section class="workspace-section">${renderCreditEditor('audioTrack', prefillAudioTrackId, prefillAudioTrack, prefillCreditSubjectLabels)}</section>
      <section class="workspace-section" aria-labelledby="replace-media-heading"><h3 id="replace-media-heading">Stored media</h3><p class="muted">Current kind: <strong>${activeMediaTypeForTrack(prefillAudioTrack) === 'video' ? 'Video' : 'Audio'}</strong>. A MediaTrack has one effective media object. Replacement publishes the new object and kind before cleaning up the previous object.</p><form method="POST" action="/content/manage/audioTrack/upload" enctype="multipart/form-data"><input type="hidden" name="audioTrackId" value="${prefillAudioTrackId || selectedUploadTrackId}" required /><label>Replacement audio<input type="file" name="audioFile" accept="audio/*" required /></label><button type="submit">Replace with Audio</button></form><form method="POST" action="/content/manage/audioTrack/video-upload" enctype="multipart/form-data"><input type="hidden" name="audioTrackId" value="${prefillAudioTrackId}" required /><label>Replacement MP4 Video<input type="file" name="videoFile" accept="video/mp4" required /></label><button type="submit">Replace with Video</button></form></section>
      <section class="card danger-zone workspace-section" aria-labelledby="delete-soundtrack-heading"><h3 id="delete-soundtrack-heading">Danger zone</h3><p>Deletion keeps the record retryable until storage cleanup completes.</p><form method="POST" action="/content/manage/audioTrack/delete"><input type="hidden" name="audioTrackId" value="${prefillAudioTrackId}" required /><button data-danger type="submit">Delete MediaTrack</button></form></section>` : '<p class="empty-linked-content">No MediaTrack selected.</p>'}
    </div>
  </div>` : ''}
  </main>
  <script src="/assets/browser-session-forms.js"></script>
  <script src="/assets/content-manager.js"></script>
</body>
</html>`;
};
