import { Request, Response, NextFunction } from 'express';
import { Song } from '../models/song';

// Create a new song via the model and save it to the db
export const postSong = (req: Request, res: Response, next: NextFunction) => {
    const title: string = req.body.title;
    const artist: string = req.body.artist;
    const genre: string = req.body.genre;
    const albumId: string = req.body.albumId;
    const year: number = req.body.year;

    // Create a new song
    const song = new Song(
        title,
        artist,
        genre,
        albumId,
        year
    );

    // Save the song to the db
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