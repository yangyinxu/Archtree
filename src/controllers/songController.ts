import { Request, Response, NextFunction } from 'express';
import { Song, Format } from '../models/song';
import { SimpleDate } from '../models/simpleDate';

// Create a new song via the model and save it to the db
export const postSong = (req: Request, res: Response, next: NextFunction) => {
    //title: string, artistIds: [string], genres: [string], albumId: string, releaseDate: Date, duration: string, format: string, coverArtUrl: string
    const title: string = req.body.title;
    const artistIds: [string] = req.body.artistIds;
    const genres: [string] = req.body.genres;
    const albumId: string = req.body.albumId;
    const releaseDate: SimpleDate = SimpleDate.fromJson(req.body.releaseDate);
    const duration: string = req.body.duration;
    const format: Format = Format.fromJson(req.body.format);
    const coverArtUrl: string = req.body.coverArtUrl;

    // Create a new song
    const song = new Song(
        title,
        artistIds,
        genres,
        albumId,
        releaseDate,
        duration,
        format,
        coverArtUrl
    );

    // Save the song to the db
    // TODO: Add the songId to the album and artist
    // TODO: Remove the songId from the album and artist if the song is deleted

    song.save()
        .then((result: any) => {
            console.log(result);
            res.status(201).json({
                message: `Song ${title} Added Successfully`,
                song: result
            });
        })
        .catch((err: any) => {
            console.log(err);
        });

};

// get a song via the model and return it
export const getSongById = (req: Request, res: Response, next: NextFunction) => {
    const songId: string = req.params.songId;

    // Fetch the song from the db
    Song.findById(songId)
        .then((song: any) => {
            res.status(200).json({
                song
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// get all songs via the model and return them
export const getSongs = (req: Request, res: Response, next: NextFunction) => {
    // Fetch all songs from the db
    Song.fetchAll()
        .then((songs: any) => {
            res.status(200).json({
                songs
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// Delete a song by id
export const deleteSong = (req: Request, res: Response, next: NextFunction) => {
    const songId: string = req.params.songId;

    // Delete the song from the db
    Song.deleteById(songId)
        .then((result: any) => {
            res.status(200).json({
                message: `Song Deleted Successfully`
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};