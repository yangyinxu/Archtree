import { Request, Response } from 'express';

import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    getListenerAlbum,
    getListenerArtist,
    getListenerAudioTrack,
    getListenerHome,
    listListenerLibrary,
    searchListenerContent
} from '../services/listenerContentService';
import {
    isLibraryContentType,
    LibraryContentType,
    LibrarySort
} from '../models/userLibrary';
import { boundedSearchQuery } from '../utils/search';

const setPublicCatalogCache = (res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
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

/** Returns public metadata for a database-confirmed ready audio track. */
export const audioTrack = async (req: Request, res: Response) => {
    const result = await getListenerAudioTrack(String(req.params.id ?? '').trim());
    if (!result) return res.status(404).json({ message: 'Audio track was not found.' });
    setPublicCatalogCache(res);
    return res.status(200).json(result);
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
