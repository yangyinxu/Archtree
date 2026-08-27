import { NextFunction, Request, Response } from 'express';

import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    getListenerAlbum,
    getListenerArtist,
    getListenerOrganization,
    getListenerAudioTrack,
    getListenerCollectionPage,
    getListenerHome,
    listListenerLibrary,
    defaultListenerCollectionPageSize,
    ListenerCollectionPageError,
    ListenerPageSlug,
    maximumListenerCollectionPageSize,
    searchListenerContent
} from '../services/listenerContentService';
import {
    isLibraryContentType,
    LibraryContentType,
    LibrarySort
} from '../models/userLibrary';
import { boundedSearchQuery } from '../utils/search';
import { isPlaylistFeatureEnabled } from '../services/playlistFeatureService';
import { catalogCreditRollout } from '../config/catalogCreditRollout';

const setPublicCatalogCache = (res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
};

/** Exposes only rollout-safe listener feature flags used to hide unavailable UI. */
export const capabilities = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const creditRollout = catalogCreditRollout();
    return res.status(200).json({
        playlists: isPlaylistFeatureEnabled(),
        catalogCredits: {
            reads: creditRollout.readsEnabled,
            sections: creditRollout.sectionsEnabled,
            organizations: creditRollout.organizationSurfacesEnabled
        }
    });
};

/** Returns the ordered listener Home without caching viewer-specific sections. */
export const home = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.vary('Cookie');
    res.vary('Authorization');
    const viewerUserId = (req as AuthenticatedRequest).auth?.userId;
    const result = await getListenerHome(viewerUserId);
    if (!result) return res.status(404).json({ message: 'Home page was not found.' });
    return res.status(200).json(result);
};

/** Returns bounded, grouped public catalog search results. */
export const search = async (req: Request, res: Response) => {
    const query = boundedSearchQuery(req.query.q, 100);
    if (!query) return res.status(400).json({ message: 'A search query is required.' });
    const requestedLimit = Number(req.query.limit ?? 20);
    if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
        return res.status(400).json({ message: 'Search limit must be a positive number.' });
    }
    setPublicCatalogCache(res);
    return res.status(200).json(await searchListenerContent(query, requestedLimit));
};

/** Returns one album detail projection and only its playable tracks. */
export const album = async (req: Request, res: Response) => {
    const result = await getListenerAlbum(String(req.params.id ?? '').trim());
    if (!result) return res.status(404).json({ message: 'Album was not found.' });
    setPublicCatalogCache(res);
    return res.status(200).json(result);
};

/** Returns one artist detail projection and only playable soundtrack metadata. */
export const artist = async (req: Request, res: Response) => {
    const result = await getListenerArtist(String(req.params.id ?? '').trim());
    if (!result) return res.status(404).json({ message: 'Artist was not found.' });
    setPublicCatalogCache(res);
    return res.status(200).json(result);
};

/** Returns one public Organization and its credited releases. */
export const organization = async (req: Request, res: Response) => {
    const result = await getListenerOrganization(String(req.params.id ?? '').trim());
    if (!result) return res.status(404).json({ message: 'Organization was not found.' });
    setPublicCatalogCache(res);
    return res.status(200).json(result);
};

/** Returns public metadata for a database-confirmed ready MediaTrack. */
export const audioTrack = async (req: Request, res: Response) => {
    const result = await getListenerAudioTrack(String(req.params.id ?? '').trim());
    if (!result) return res.status(404).json({ message: 'MediaTrack was not found.' });
    setPublicCatalogCache(res);
    return res.status(200).json(result);
};

/** Returns one strict, page-scoped Grid/List slice without exposing its definition document. */
export const collectionPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const pageSlug = String(req.params.slug ?? '').trim().toLowerCase();
        if (pageSlug !== 'home' && pageSlug !== 'library') {
            return res.status(404).json({ message: 'Grid/List page item was not found.' });
        }
        if (Object.keys(req.query).some((key) => key !== 'limit' && key !== 'cursor')) {
            return res.status(400).json({
                code: 'invalid_collection_page_query',
                message: 'Grid/List pagination accepts only limit and cursor.'
            });
        }
        const rawLimit = req.query.limit;
        if (Array.isArray(rawLimit) || (rawLimit !== undefined && typeof rawLimit !== 'string')) {
            return res.status(400).json({
                code: 'invalid_collection_page_limit',
                message: 'Grid/List limit is invalid.'
            });
        }
        const requestedLimit = rawLimit === undefined
            ? defaultListenerCollectionPageSize
            : Number(rawLimit);
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
            return res.status(400).json({
                code: 'invalid_collection_page_limit',
                message: 'Grid/List limit must be a positive integer.'
            });
        }
        const rawCursor = req.query.cursor;
        if (Array.isArray(rawCursor) || (rawCursor !== undefined && typeof rawCursor !== 'string')) {
            return res.status(400).json({
                code: 'invalid_collection_cursor',
                message: 'Collection cursor is invalid.'
            });
        }

        const auth = (req as AuthenticatedRequest).auth;
        const result = await getListenerCollectionPage(
            pageSlug as ListenerPageSlug,
            String(req.params.itemId ?? ''),
            Math.min(requestedLimit, maximumListenerCollectionPageSize),
            rawCursor,
            auth?.userId
        );
        if (pageSlug === 'library' || auth) {
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Pragma', 'no-cache');
            res.vary('Cookie');
            res.vary('Authorization');
        } else {
            setPublicCatalogCache(res);
        }
        return res.status(200).json(result);
    } catch (error) {
        if (error instanceof ListenerCollectionPageError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message });
        }
        return next(error);
    }
};

/** Wraps the complete server Library in a lifecycle-safe public projection. */
export const library = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const requestedTypes = String(req.query.types ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (requestedTypes.some((value) => !isLibraryContentType(value))) {
        return res.status(400).json({ message: 'Library types must be album or audioTrack.' });
    }
    const requestedSort = String(req.query.sort ?? 'recentActivity');
    const allowedSorts: LibrarySort[] = ['recentActivity', 'recentlySaved', 'recentlyPlayed'];
    if (!allowedSorts.includes(requestedSort as LibrarySort)) {
        return res.status(400).json({ message: 'Library sort is invalid.' });
    }
    const requestedLimit = Number(req.query.limit ?? 50);
    if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
        return res.status(400).json({ message: 'Library limit must be a positive number.' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.vary('Cookie');
    res.vary('Authorization');
    return res.status(200).json(await listListenerLibrary(auth.userId, {
        contentTypes: requestedTypes as LibraryContentType[],
        sort: requestedSort as LibrarySort,
        limit: Math.floor(requestedLimit),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    }));
};
