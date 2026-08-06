import { Request, Response, NextFunction } from 'express';
import { ObjectId } from 'mongodb';
import { Album } from '../models/album';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    deleteCoverArt,
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt,
    validateCoverArtFile
} from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';
import { getPublicAlbum, listPublicAlbums } from '../services/publicCatalogService';
import { boundedLimit, boundedOffset } from '../utils/pagination';
import { deleteAlbumAndReferences } from '../services/albumLifecycleService';

type UploadedCoverArt = { imageId: string; coverArtUrl: string };

interface NewAlbumPublicationDependencies {
    saveAlbum?: () => Promise<unknown>;
    deleteUploadedCoverArt?: (imageId: string, albumId: string) => Promise<void>;
}

/** Publishes a ready Album only after optional artwork is ready and attached in the insert. */
export const publishNewAlbum = async (
    album: Album,
    coverArt?: UploadedCoverArt,
    dependencies: NewAlbumPublicationDependencies = {}
) => {
    const albumId = album._id?.toHexString();
    if (!albumId) throw new Error('A server-generated Album ID is required before publication.');
    if (coverArt) {
        album.coverArtId = coverArt.imageId;
        album.coverArtUrl = coverArt.coverArtUrl;
    }

    try {
        return await (dependencies.saveAlbum ?? (() => album.save()))();
    } catch (error) {
        if (!coverArt || (error as any)?.outcomeUnknown) throw error;
        try {
            if (dependencies.deleteUploadedCoverArt) {
                await dependencies.deleteUploadedCoverArt(coverArt.imageId, albumId);
            } else {
                await deleteCoverArt(coverArt.imageId, {
                    expectedOwnerType: 'album',
                    expectedOwnerId: albumId
                });
            }
        } catch (cleanupError) {
            throw Object.assign(
                new Error('Album creation failed and uploaded cover-art cleanup requires reconciliation.'),
                {
                    statusCode: 503,
                    code: 'album_creation_cleanup_pending',
                    cleanupPending: true,
                    reconciliationRequired: true,
                    cause: { creationError: error, cleanupError }
                }
            );
        }
        throw error;
    }
};

// Create a new album via the model and save it to the db
export const postAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const title: string = req.body.title;
    const coverArtUrl: string = req.body.coverArtUrl;
    if (req.body.audioTrackIds !== undefined && !Array.isArray(req.body.audioTrackIds)) {
        return res.status(400).json({ message: 'audioTrackIds must be an array.' });
    }
    const audioTrackIds = (req.body.audioTrackIds ?? []).map(String) as [string];
    const releaseDate: SimpleDate = SimpleDate.fromJson(req.body.releaseDate);

    // Create a new album
    const albumObjectId = new ObjectId();
    const album = new Album(
        title,
        coverArtUrl,
        audioTrackIds,
        releaseDate,
        authReq.auth.userId,
        albumObjectId
    );

    const coverArtFile = getUploadedFile(req, 'coverArtFile');

    try {
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const albumId = albumObjectId.toHexString();
        let coverArt: UploadedCoverArt | undefined;
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
        return res.status(201).json({
            message: `Album ${title} Added Successfully`,
            album
        });
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return res.status(503).json({
                message: 'Album creation outcome could not be confirmed. Reconciliation is required before retrying.',
                cleanupPending: true,
                reconciliationRequired: true
            });
        }
        if ((error as any)?.code === 'album_creation_cleanup_pending') {
            return res.status(503).json({
                message: 'Album was not created. Uploaded cover-art cleanup requires reconciliation.',
                cleanupPending: true,
                reconciliationRequired: true
            });
        }
        return next(error);
    }
};

export const updateAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const albumId = req.params.albumId;
    const album = await Album.findReadyById(albumId);
    if (!album) {
        return res.status(404).json({ message: 'Album not found.' });
    }

    const updatePayload: Record<string, unknown> = {};
    const coverArtFile = getUploadedFile(req, 'coverArtFile');
    let replacementCoverArtId: string | undefined;
    const removeCoverArt = !coverArtFile
        && String(req.body.removeCoverArt ?? '').toLowerCase() === 'true';
    if (req.body.title !== undefined) updatePayload.title = req.body.title;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.audioTrackIds !== undefined) {
        if (!Array.isArray(req.body.audioTrackIds)) {
            return res.status(400).json({ message: 'audioTrackIds must be an array.' });
        }
        updatePayload.audioTrackIds = req.body.audioTrackIds.map(String);
    }
    if (req.body.releaseDate !== undefined) updatePayload.releaseDate = SimpleDate.fromJson(req.body.releaseDate);

    if (coverArtFile) {
        const coverArt = await uploadCoverArt('album', albumId, coverArtFile, authReq.auth.userId);
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
        return res.status((cleanup as any).outcomeUnknown ? 503 : 409).json({
            message: 'Album was not updated because its cover art changed concurrently or its lifecycle evidence is invalid.',
            cleanupPending: cleanup.cleanupPending
        });
    }
    return res.status(200).json({
        message: 'Album updated successfully.',
        cleanupPending: cleanup.cleanupPending
    });
};

export const deleteAlbum = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const albumId = req.params.albumId;
    const album = await Album.findById(albumId);
    if (!album) {
        return res.status(404).json({ message: 'Album not found.' });
    }

    const cleanup = await deleteAlbumAndReferences(albumId);
    if (!cleanup.ownerDeleted) {
        return res.status(409).json({
            message: 'Album was retained for retry and lifecycle reconciliation.',
            cleanupPending: true
        });
    }
    return res.status(200).json({
        message: 'Album deleted successfully.',
        cleanupPending: cleanup.cleanupPending
    });
};

// get an album via the model and return it
export const getAlbumById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const album = await getPublicAlbum(req.params.albumId);
        return res.status(album ? 200 : 404).json({ album });
    } catch (error) {
        return next(error);
    }
};

// get all albums via the model and return them
export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = boundedLimit(req.query.limit, 50, 100);
        const offset = boundedOffset(req.query.offset);
        const albums = await listPublicAlbums(limit, offset);
        return res.status(200).json({ albums, limit, offset });
    } catch (error) {
        return next(error);
    }
};
