/** Loads administrator inventory and adapts page/search requests without owning publication writes. */
import { Request, Response, NextFunction } from 'express';
import { Artist } from '../../models/artist';
import { Album } from '../../models/album';
import { AudioTrack } from '../../models/audioTrack';
import { Carousel } from '../../models/carousel';
import { Page } from '../../models/page';
import { ContentCollection } from '../../models/contentCollection';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { randomUUID } from 'node:crypto';
import { renderAudioTracksPage } from '../../views/contentManager/audioTracksView';
import { loadS3StorageSummary } from '../../services/s3StorageService';
import { boundedSearchQuery } from '../../utils/search';
import {
    ManagementInventoryPage,
    managementInventoryOffset,
    managementInventoryPageSize,
    normalizeManagementInventoryPage,
    toManagementInventoryPage
} from '../../views/contentManager/inventoryPagination';
import { boundedLimit } from '../../utils/pagination';
import { listArtistReleaseOperations } from '../../services/artistReleaseWorkflowService';
import { Organization, organizationTypes } from '../../models/organization';
import { maxAudioBatchFiles } from '../../middleware/audioUpload';
import {
    inventoryQueryNames,
    InventoryKey,
    managerViewFromQuery,
    catalogSectionFromQuery
} from '../../views/contentManager/managementNavigation';
import { rejectNonAdminManagerRequest } from './requestHelpers';
import { renderManagePage } from '../../views/contentManager/managePageView';
import { contentId } from '../../utils/catalogValues';

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

/** Loads bounded global MediaTrack inventory for the administrator operations view. */
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

/** Loads bounded inventory and focused editing context before invoking the pure page renderer. */
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
                        message = 'Unable to load MediaTrack for this ID.';
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
            maxAudioBatchFiles,
            organizationTypes,
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
            managerView: req.query.view ? managerViewFromQuery(req.query.view) : prefillType ? 'catalog' : 'overview',
            catalogSection: catalogSectionFromQuery(req.query.catalogType)
        }));
    } catch (error) {
        return next(error);
    }
};

/** Combines bounded catalog matches with inventory context for the administrator search view. */
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
            maxAudioBatchFiles,
            organizationTypes,
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
            managerView: 'catalog',
            catalogSection: catalogSectionFromQuery(req.query.catalogType)
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
