import { Request, Response, NextFunction } from 'express';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';

// Create a new audio track via the model and save it to the db
export const postAudioTrack = (req: Request, res: Response, next: NextFunction) => {
    const title: string = req.body.title;
    const artistIds: [string] = req.body.artistIds;
    const genres: [string] = req.body.genres;
    const albumId: string = req.body.albumId;
    const releaseDate: SimpleDate = SimpleDate.fromJson(req.body.releaseDate);
    const duration: string = req.body.duration;
    const format: AudioFormat = AudioFormat.fromJson(req.body.format);
    const coverArtUrl: string = req.body.coverArtUrl;

    // Create a new audio track
    const track = new AudioTrack(
        title,
        artistIds,
        genres,
        albumId,
        releaseDate,
        duration,
        format,
        coverArtUrl
    );

    // Save the audio track to the db
    // TODO: Add the audioTrackId to the album and artist
    // TODO: Remove the audioTrackId from the album and artist if the audio track is deleted

    track.save()
        .then((result: any) => {
            console.log(result);
            res.status(201).json({
                message: `Audio Track ${title} Added Successfully`,
                audioTrack: result
            });
        })
        .catch((err: any) => {
            console.log(err);
        });

};

// Get an audio track via the model and return it
export const getAudioTrackById = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;

    // Fetch the audio track from the db
    AudioTrack.findById(audioTrackId)
        .then((audioTrack: any) => {
            res.status(200).json({
                audioTrack
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// Get all audio tracks via the model and return them
export const getAudioTracks = (req: Request, res: Response, next: NextFunction) => {
    // Fetch all audio tracks from the db
    AudioTrack.fetchAll()
        .then((audioTracks: any) => {
            res.status(200).json({
                audioTracks
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};

// Delete an audio track by id
export const deleteAudioTrack = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;

    // Delete the audio track from the db
    AudioTrack.deleteById(audioTrackId)
        .then((result: any) => {
            res.status(200).json({
                message: `Audio Track Deleted Successfully`
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
};