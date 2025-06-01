import { Request, Response, NextFunction } from 'express';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { getS3 } from '../app';

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

    // Fetch the audio track from AWS S3
    getS3().getObject({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: audioTrackId
    }, (err: any, data: any) => {
        if (err) {
            console.log(err);
            res.status(500).send('Error fetching audio track from AWS S3');
        } else {
            res.status(200).send(data.Body);
        }
    });

    // Fetch the audio track from the db
    /*
    AudioTrack.findById(audioTrackId)
        .then((audioTrack: any) => {
            res.status(200).json({
                audioTrack
            });
        })
        .catch((error: any) => {
            console.log(error);
        });
    */
};

// Stream an audio track by id from AWS S3 with support for HTTP Range requests
export const streamAudioTrack = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;
    const s3 = getS3();
    const params = {
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: audioTrackId
    };

    // Check for Range header
    const range = req.headers.range;
    s3.headObject(params, (err: any, metadata: any) => {
        if (err || !metadata.ContentLength) {
            console.error('Error getting metadata:', err);
            res.status(500).send('Error streaming audio track');
            return;
        }

        const fileSize = metadata.ContentLength;
        let start = 0;
        let end = fileSize - 1;

        if (range) {
            const match = /bytes=(\d+)-(\d*)/.exec(range);
            if (match) {
                start = parseInt(match[1], 10);
                if (match[2]) {
                    end = parseInt(match[2], 10);
                }
            }
            // Ensure start and end are within bounds
            if (start > end || end >= fileSize) {
                res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
                return;
            }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        } else {
            res.status(200);
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Disposition', `inline; filename="${audioTrackId}"`);

        const stream = s3.getObject({ ...params, Range: `bytes=${start}-${end}` }).createReadStream();
        stream.on('error', (error: any) => {
            console.error('Error streaming audio track:', error);
            res.status(500).send('Error streaming audio track');
        });
        stream.pipe(res);
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

// Get an audio track from AWS S3
export const getAudioFile = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;

    
}