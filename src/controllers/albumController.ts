import { Request, Response, NextFunction } from 'express';
import { Album } from '../models/album';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { deleteCoverArt, uploadCoverArt, validateCoverArtFile } from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';

// Create a new album via the model and save it to the db
export const postAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const title: string = req.body.title;
    const coverArtUrl: string = req.body.coverArtUrl;
    const audioTrackIds: [string] = req.body.audioTrackIds;
    const releaseDate: SimpleDate = SimpleDate.fromJson(req.body.releaseDate);

    // Create a new album
    const album = new Album(
        title,
        coverArtUrl,
        audioTrackIds,
        releaseDate,
        authReq.auth.userId
    );

    const coverArtFile = getUploadedFile(req, 'coverArtFile');

    try {
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const result = await album.save();
        const albumId = result.insertedId.toHexString();
        try {
            if (coverArtFile) {
                const coverArt = await uploadCoverArt('album', albumId, coverArtFile, authReq.auth.userId);
                await Album.updateById(albumId, {
                    coverArtId: coverArt.imageId,
                    coverArtUrl: coverArt.coverArtUrl
                });
            }
        } catch (error) {
            await Album.deleteById(albumId).catch(() => undefined);
            throw error;
        }
        const createdAlbum = await Album.findById(albumId);
        return res.status(201).json({
            message: `Album ${title} Added Successfully`,
            album: createdAlbum
        });
    } catch (error) {
        console.log(error);
        return next(error);
    }
};

export const updateAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const albumId = req.params.albumId;
    const album = await Album.findById(albumId);
    if (!album) {
        return res.status(404).json({ message: 'Album not found.' });
    }

    if (!ensureOwnerOrAdmin(authReq, album.createdBy ?? '')) {
        return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
    }

    const updatePayload: Record<string, unknown> = {};
    const coverArtFile = getUploadedFile(req, 'coverArtFile');
    let replacementCoverArtId: string | undefined;
    if (req.body.title !== undefined) updatePayload.title = req.body.title;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.audioTrackIds !== undefined) updatePayload.audioTrackIds = req.body.audioTrackIds;
    if (req.body.releaseDate !== undefined) updatePayload.releaseDate = SimpleDate.fromJson(req.body.releaseDate);

    if (coverArtFile) {
        const coverArt = await uploadCoverArt('album', albumId, coverArtFile, authReq.auth.userId);
        replacementCoverArtId = coverArt.imageId;
        updatePayload.coverArtId = coverArt.imageId;
        updatePayload.coverArtUrl = coverArt.coverArtUrl;
    } else if (String(req.body.removeCoverArt ?? '').toLowerCase() === 'true') {
        await deleteCoverArt(album.coverArtId);
        updatePayload.coverArtId = null;
        updatePayload.coverArtUrl = '';
    }

    await Album.updateById(albumId, updatePayload);
    let cleanupPending = false;
    if (replacementCoverArtId && album.coverArtId && album.coverArtId !== replacementCoverArtId) {
        await deleteCoverArt(album.coverArtId).catch((error) => {
            cleanupPending = true;
            console.log(`Unable to delete replaced album cover art ${album.coverArtId}:`, error);
        });
    }
    return res.status(200).json({ message: 'Album updated successfully.', cleanupPending });
};

export const deleteAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const albumId = req.params.albumId;
    const album = await Album.findById(albumId);
    if (!album) {
        return res.status(404).json({ message: 'Album not found.' });
    }

    if (!ensureOwnerOrAdmin(authReq, album.createdBy ?? '')) {
        return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
    }

    await deleteCoverArt(album.coverArtId);
    await Album.deleteById(albumId);
    return res.status(200).json({ message: 'Album deleted successfully.' });
};

// get an album via the model and return it
export const getAlbumById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const album = await Album.findById(req.params.albumId);
        return res.status(album ? 200 : 404).json({ album });
    } catch (error) {
        return next(error);
    }
};

// get all albums via the model and return them
export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const albums = await Album.fetchAll(limit, offset);
        return res.status(200).json({ albums, limit, offset });
    } catch (error) {
        return next(error);
    }
};
