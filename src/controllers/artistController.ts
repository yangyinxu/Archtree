import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';

// Create a new artist via the model and save it to the db
export const postArtist = (req: Request, res: Response, next: NextFunction) => {
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

    // Save the artist to the db
    artist.save()
        .then((result: any) => {
            console.log(result);
            res.status(201).json({
                message: `Artist ${name} Added Successfully`,
                artist: result
            });
        })
        .catch((err: any) => {
            console.log(err);
            res.status(500).json({ message: 'Failed to create artist.' });
        });

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
    if (req.body.name !== undefined) updatePayload.name = req.body.name;
    if (req.body.bio !== undefined) updatePayload.bio = req.body.bio;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.albumIds !== undefined) updatePayload.albumIds = req.body.albumIds;
    if (req.body.birthDate !== undefined) updatePayload.birthDate = SimpleDate.fromJson(req.body.birthDate);

    await Artist.updateById(artistId, updatePayload);
    return res.status(200).json({ message: 'Artist updated successfully.' });
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

    await Artist.deleteById(artistId);
    return res.status(200).json({ message: 'Artist deleted successfully.' });
};

// get an artist via the model and return it
export const getArtistById = (req: Request, res: Response, next: NextFunction) => {
    const artistId: string = req.params.artistId;

    // Fetch the artist from the db
    Artist.findById(artistId)
        .then((artist: any) => {
            res.status(200).json({
                artist
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// get all artists via the model and return them
export const getArtists = (req: Request, res: Response, next: NextFunction) => {
    Artist.fetchAll()
        .then((artists: any) => {
            res.status(200).json({
                artists
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};
