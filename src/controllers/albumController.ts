import { Request, Response, NextFunction } from 'express';
import { Album } from '../models/album';
import { SimpleDate } from '../models/simpleDate';

// Create a new album via the model and save it to the db
export const postAlbum = (req: Request, res: Response, next: NextFunction) => {
    const title: string = req.body.title;
    const coverArtUrl: string = req.body.coverArtUrl;
    const audioTrackIds: [string] = req.body.audioTrackIds;
    const releaseDate: SimpleDate = SimpleDate.fromJson(req.body.releaseDate);

    // Create a new album
    const album = new Album(
        title,
        coverArtUrl,
        audioTrackIds,
        releaseDate
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
        });

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