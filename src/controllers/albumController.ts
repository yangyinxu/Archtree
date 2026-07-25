import { Request, Response, NextFunction } from 'express';
import { Album } from '../models/album';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';

// Create a new album via the model and save it to the db
export const postAlbum = (req: Request, res: Response, next: NextFunction) => {
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

    // Save the album to the db
    album.save()
        .then((result: any) => {
            console.log(result);
            res.status(201).json({
                message: `Album ${title} Added Successfully`,
                album: result
            });
        })
        .catch((err: any) => {
            console.log(err);
            res.status(500).json({ message: 'Failed to create album.' });
        });

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
    if (req.body.title !== undefined) updatePayload.title = req.body.title;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.audioTrackIds !== undefined) updatePayload.audioTrackIds = req.body.audioTrackIds;
    if (req.body.releaseDate !== undefined) updatePayload.releaseDate = SimpleDate.fromJson(req.body.releaseDate);

    await Album.updateById(albumId, updatePayload);
    return res.status(200).json({ message: 'Album updated successfully.' });
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

    await Album.deleteById(albumId);
    return res.status(200).json({ message: 'Album deleted successfully.' });
};

// get an album via the model and return it
export const getAlbumById = (req: Request, res: Response, next: NextFunction) => {
    const albumId: string = req.params.albumId;

    // Fetch the album from the db
    Album.findById(albumId)
        .then((album: any) => {
            res.status(200).json({
                album
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// get all albums via the model and return them
export const getAlbums = (req: Request, res: Response, next: NextFunction) => {
    Album.fetchAll()
        .then((albums: any) => {
            res.status(200).json({
                albums
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};