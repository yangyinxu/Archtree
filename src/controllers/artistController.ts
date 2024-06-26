import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { SimpleDate } from '../models/simpleDate';

// Create a new artist via the model and save it to the db
export const postArtist = (req: Request, res: Response, next: NextFunction) => {
    const name: string = req.body.name;
    // Convert the birthDate to a SimpleDate object with SimpleDate.fromJson()
    const birthDate: SimpleDate = SimpleDate.fromJson(req.body.birthDate);
    const bio: string = req.body.bio;
    const coverArtUrl: string = req.body.coverArtUrl;
    const albumIds: [string] = req.body.albumIds;
    const audioTrackIds: [string] = req.body.audioTrackIds;

    // Create a new artist
    const artist = new Artist(
        name,
        birthDate,
        bio,
        coverArtUrl,
        albumIds,
        audioTrackIds
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
        });

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