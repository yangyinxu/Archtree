import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { deleteCoverArt, uploadCoverArt, validateCoverArtFile } from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';

// Create a new artist via the model and save it to the db
export const postArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const name: string = req.body.name;
    // Convert the birthDate to a SimpleDate object with SimpleDate.fromJson()
    const birthDate: SimpleDate = SimpleDate.fromJson(req.body.birthDate);
    const bio: string = req.body.bio;
    const coverArtUrl: string = req.body.coverArtUrl;
    const albumIds: [string] = req.body.albumIds;

    // Create a new artist
    const artist = new Artist(
        name,
        birthDate,
        bio,
        coverArtUrl,
        albumIds,
        authReq.auth.userId
    );

    const coverArtFile = getUploadedFile(req, 'coverArtFile');

    try {
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const result = await artist.save();
        const artistId = result.insertedId.toHexString();
        try {
            if (coverArtFile) {
                const coverArt = await uploadCoverArt('artist', artistId, coverArtFile, authReq.auth.userId);
                await Artist.updateById(artistId, {
                    coverArtId: coverArt.imageId,
                    coverArtUrl: coverArt.coverArtUrl
                });
            }
        } catch (error) {
            await Artist.deleteById(artistId).catch(() => undefined);
            throw error;
        }
        const createdArtist = await Artist.findById(artistId);
        return res.status(201).json({
            message: `Artist ${name} Added Successfully`,
            artist: createdArtist
        });
    } catch (error) {
        console.log(error);
        return next(error);
    }
};

export const updateArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const artistId = req.params.artistId;
    const artist = await Artist.findById(artistId);
    if (!artist) {
        return res.status(404).json({ message: 'Artist not found.' });
    }

    if (!ensureOwnerOrAdmin(authReq, artist.createdBy ?? '')) {
        return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
    }

    const updatePayload: Record<string, unknown> = {};
    const coverArtFile = getUploadedFile(req, 'coverArtFile');
    let replacementCoverArtId: string | undefined;
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
    } else if (String(req.body.removeCoverArt ?? '').toLowerCase() === 'true') {
        await deleteCoverArt(artist.coverArtId);
        updatePayload.coverArtId = null;
        updatePayload.coverArtUrl = '';
    }

    await Artist.updateById(artistId, updatePayload);
    let cleanupPending = false;
    if (replacementCoverArtId && artist.coverArtId && artist.coverArtId !== replacementCoverArtId) {
        await deleteCoverArt(artist.coverArtId).catch((error) => {
            cleanupPending = true;
            console.log(`Unable to delete replaced artist cover art ${artist.coverArtId}:`, error);
        });
    }
    return res.status(200).json({ message: 'Artist updated successfully.', cleanupPending });
};

export const deleteArtist = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const artistId = req.params.artistId;
    const artist = await Artist.findById(artistId);
    if (!artist) {
        return res.status(404).json({ message: 'Artist not found.' });
    }

    if (!ensureOwnerOrAdmin(authReq, artist.createdBy ?? '')) {
        return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
    }

    await deleteCoverArt(artist.coverArtId);
    await Artist.deleteById(artistId);
    return res.status(200).json({ message: 'Artist deleted successfully.' });
};

// get an artist via the model and return it
export const getArtistById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const artist = await Artist.findById(req.params.artistId);
        return res.status(artist ? 200 : 404).json({ artist });
    } catch (error) {
        return next(error);
    }
};

// get all artists via the model and return them
export const getArtists = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const artists = await Artist.fetchAll(limit, offset);
        return res.status(200).json({ artists, limit, offset });
    } catch (error) {
        return next(error);
    }
};
