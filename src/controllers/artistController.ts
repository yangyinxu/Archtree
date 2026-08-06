import { Request, Response, NextFunction } from 'express';
import { ObjectId } from 'mongodb';
import { Artist } from '../models/artist';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    deleteCoverArt,
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt,
    validateCoverArtFile
} from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';
import { getPublicArtist, listPublicArtists } from '../services/publicCatalogService';
import { boundedLimit, boundedOffset } from '../utils/pagination';
import { deleteArtistAndReferences } from '../services/artistLifecycleService';

type UploadedCoverArt = { imageId: string; coverArtUrl: string };

interface NewArtistPublicationDependencies {
    saveArtist?: () => Promise<unknown>;
    deleteUploadedCoverArt?: (imageId: string, artistId: string) => Promise<void>;
}

/** Publishes a ready Artist only after optional artwork is ready and attached in the insert. */
export const publishNewArtist = async (
    artist: Artist,
    coverArt?: UploadedCoverArt,
    dependencies: NewArtistPublicationDependencies = {}
) => {
    const artistId = artist._id?.toHexString();
    if (!artistId) throw new Error('A server-generated Artist ID is required before publication.');
    if (coverArt) {
        artist.coverArtId = coverArt.imageId;
        artist.coverArtUrl = coverArt.coverArtUrl;
    }

    try {
        return await (dependencies.saveArtist ?? (() => artist.save()))();
    } catch (error) {
        if (!coverArt || (error as any)?.outcomeUnknown) throw error;
        try {
            if (dependencies.deleteUploadedCoverArt) {
                await dependencies.deleteUploadedCoverArt(coverArt.imageId, artistId);
            } else {
                await deleteCoverArt(coverArt.imageId, {
                    expectedOwnerType: 'artist',
                    expectedOwnerId: artistId
                });
            }
        } catch (cleanupError) {
            throw Object.assign(
                new Error('Artist creation failed and uploaded cover-art cleanup requires reconciliation.'),
                {
                    statusCode: 503,
                    code: 'artist_creation_cleanup_pending',
                    cleanupPending: true,
                    reconciliationRequired: true,
                    cause: { creationError: error, cleanupError }
                }
            );
        }
        throw error;
    }
};

// Create a new artist via the model and save it to the db
export const postArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const name: string = req.body.name;
    // Convert the birthDate to a SimpleDate object with SimpleDate.fromJson()
    const birthDate: SimpleDate = SimpleDate.fromJson(req.body.birthDate);
    const bio: string = req.body.bio;
    const coverArtUrl: string = req.body.coverArtUrl;
    const albumIds: [string] = req.body.albumIds;

    // Create a new artist
    const artistObjectId = new ObjectId();
    const artist = new Artist(
        name,
        birthDate,
        bio,
        coverArtUrl,
        albumIds,
        authReq.auth.userId,
        artistObjectId
    );

    const coverArtFile = getUploadedFile(req, 'coverArtFile');

    try {
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const artistId = artistObjectId.toHexString();
        let coverArt: UploadedCoverArt | undefined;
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
        return res.status(201).json({
            message: `Artist ${name} Added Successfully`,
            artist
        });
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return res.status(503).json({
                message: 'Artist creation outcome could not be confirmed. Reconciliation is required before retrying.',
                cleanupPending: true,
                reconciliationRequired: true
            });
        }
        if ((error as any)?.code === 'artist_creation_cleanup_pending') {
            return res.status(503).json({
                message: 'Artist was not created. Uploaded cover-art cleanup requires reconciliation.',
                cleanupPending: true,
                reconciliationRequired: true
            });
        }
        return next(error);
    }
};

export const updateArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const artistId = req.params.artistId;
    const artist = await Artist.findReadyById(artistId);
    if (!artist) {
        return res.status(404).json({ message: 'Artist not found.' });
    }

    const updatePayload: Record<string, unknown> = {};
    const coverArtFile = getUploadedFile(req, 'coverArtFile');
    let replacementCoverArtId: string | undefined;
    const removeCoverArt = !coverArtFile
        && String(req.body.removeCoverArt ?? '').toLowerCase() === 'true';
    if (req.body.name !== undefined) updatePayload.name = req.body.name;
    if (req.body.bio !== undefined) updatePayload.bio = req.body.bio;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.albumIds !== undefined) updatePayload.albumIds = req.body.albumIds;
    if (req.body.birthDate !== undefined) updatePayload.birthDate = SimpleDate.fromJson(req.body.birthDate);

    if (coverArtFile) {
        const coverArt = await uploadCoverArt('artist', artistId, coverArtFile, authReq.auth.userId);
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
        return res.status(409).json({
            message: 'Artist was not updated because its cover art changed concurrently or its lifecycle evidence is invalid.',
            cleanupPending: cleanup.cleanupPending
        });
    }
    return res.status(200).json({
        message: 'Artist updated successfully.',
        cleanupPending: cleanup.cleanupPending
    });
};

export const deleteArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (authReq.auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    const artistId = req.params.artistId;
    const artist = await Artist.findById(artistId);
    if (!artist) {
        return res.status(404).json({ message: 'Artist not found.' });
    }

    const cleanup = await deleteArtistAndReferences(artistId);
    if (!cleanup.ownerDeleted) {
        return res.status(409).json({
            message: 'Artist was retained for retry and lifecycle reconciliation.',
            cleanupPending: true
        });
    }
    return res.status(200).json({
        message: 'Artist deleted successfully.',
        cleanupPending: cleanup.cleanupPending
    });
};

// get an artist via the model and return it
export const getArtistById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const artist = await getPublicArtist(req.params.artistId);
        return res.status(artist ? 200 : 404).json({ artist });
    } catch (error) {
        return next(error);
    }
};

// get all artists via the model and return them
export const getArtists = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = boundedLimit(req.query.limit, 50, 100);
        const offset = boundedOffset(req.query.offset);
        const artists = await listPublicArtists(limit, offset);
        return res.status(200).json({ artists, limit, offset });
    } catch (error) {
        return next(error);
    }
};
