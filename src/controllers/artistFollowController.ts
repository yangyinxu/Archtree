import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware';
import { ArtistFollowError, artistFollowStatuses, canonicalFollowArtistId, followArtist, unfollowArtist } from '../services/artistFollowService';

/** Applied before authentication as even private failures must not enter a shared cache. */
export const privateArtistFollowResponse = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.vary('Cookie');
    res.vary('Authorization');
    next();
};

export const statuses = async (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(req.query).length > 0 || Object.keys(body).length !== 1 || !Array.isArray(body.artistIds)
        || body.artistIds.length > 100 || body.artistIds.some((id: unknown) => !canonicalFollowArtistId(id))) {
        return res.status(400).json({ code: 'INVALID_ARTIST_FOLLOWS', message: 'Provide at most 100 valid Artist IDs.' });
    }
    const ids = body.artistIds.map((id: string) => canonicalFollowArtistId(id)!);
    return res.status(200).json({ items: await artistFollowStatuses((req as AuthenticatedRequest).auth!.userId, ids) });
};

const mutate = (following: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    const artistId = canonicalFollowArtistId(req.params.artistId);
    if (!artistId || (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body)))
        || Object.keys(req.body ?? {}).length || Object.keys(req.query).length) {
        return res.status(400).json({ code: 'INVALID_ARTIST_FOLLOW', message: 'A valid Artist ID and no extra fields are required.' });
    }
    try {
        const userId = (req as AuthenticatedRequest).auth!.userId;
        return res.status(200).json(await (following ? followArtist(userId, artistId) : unfollowArtist(userId, artistId)));
    } catch (error) {
        if (error instanceof ArtistFollowError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
        return next(error);
    }
};
export const follow = mutate(true);
export const unfollow = mutate(false);
