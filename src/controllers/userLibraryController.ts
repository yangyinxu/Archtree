import { NextFunction, Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    isLibraryContentType,
    LibraryContentType,
    LibrarySort,
    normalizeLibraryContentId,
    UserLibrary
} from '../models/userLibrary';
import { listListenerLibrary } from '../services/listenerContentService';

const parseTarget = (req: Request) => {
    const contentType = String(req.params.contentType ?? '').trim();
    const contentId = normalizeLibraryContentId(String(req.params.contentId ?? ''));
    return isLibraryContentType(contentType) && contentId ? { contentType, contentId } : null;
};

export const saveContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = (req as AuthenticatedRequest).auth!;
        const target = parseTarget(req);
        if (!target) return res.status(400).json({ message: 'A valid content type and ID are required.' });
        if (!await UserLibrary.contentExists(target.contentType, target.contentId)) {
            return res.status(404).json({ message: 'Content was not found.' });
        }
        await UserLibrary.save(auth.userId, target.contentType, target.contentId);
        return res.status(200).json({ ...target, saved: true });
    } catch (error) {
        return next(error);
    }
};

export const unsaveContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = (req as AuthenticatedRequest).auth!;
        const target = parseTarget(req);
        if (!target) return res.status(400).json({ message: 'A valid content type and ID are required.' });
        await UserLibrary.unsave(auth.userId, target.contentType, target.contentId);
        return res.status(200).json({ ...target, saved: false });
    } catch (error) {
        return next(error);
    }
};

export const getSaveStatuses = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = (req as AuthenticatedRequest).auth!;
        const rawItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
        const items = rawItems.map((item: any) => ({
            contentType: String(item?.contentType ?? ''),
            contentId: normalizeLibraryContentId(String(item?.contentId ?? ''))
        }));
        if (items.some((item: any) => !isLibraryContentType(item.contentType) || !item.contentId)) {
            return res.status(400).json({ message: 'Every item must have a valid content type and ID.' });
        }
        return res.status(200).json({ items: await UserLibrary.statuses(auth.userId, items as any) });
    } catch (error) {
        return next(error);
    }
};

export const listLibrary = async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (error) {
        return next(error);
    }
};

export const recordRecentlyPlayed = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = (req as AuthenticatedRequest).auth!;
        const contentType = String(req.body?.contentType ?? '').trim();
        const contentId = normalizeLibraryContentId(String(req.body?.contentId ?? ''));
        if (!isLibraryContentType(contentType) || !contentId) {
            return res.status(400).json({ message: 'A valid content type and ID are required.' });
        }
        if (!await UserLibrary.contentExists(contentType, contentId)) {
            return res.status(404).json({ message: 'Content was not found.' });
        }
        await UserLibrary.recordPlayed(auth.userId, contentType, contentId);
        return res.status(200).json({ contentType, contentId, recorded: true });
    } catch (error) {
        return next(error);
    }
};
