import { Request, Response, NextFunction } from 'express';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { getS3 } from '../app';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';

// Create a new audio track via the model and save it to the db
export const postAudioTrack = (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

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
        coverArtUrl,
        authReq.auth.userId
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
            res.status(500).json({ message: 'Failed to create audio track.' });
        });

};

export const updateAudioTrack = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const audioTrackId: string = req.params.audioTrackId;
    const audioTrack = await AudioTrack.findById(audioTrackId);
    if (!audioTrack) {
        return res.status(404).json({ message: 'Audio track not found.' });
    }

    if (!ensureOwnerOrAdmin(authReq, audioTrack.createdBy ?? '')) {
        return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
    }

    const updatePayload: Record<string, unknown> = {};
    if (req.body.title !== undefined) updatePayload.title = req.body.title;
    if (req.body.artistIds !== undefined) updatePayload.artistIds = req.body.artistIds;
    if (req.body.genres !== undefined) updatePayload.genres = req.body.genres;
    if (req.body.albumId !== undefined) updatePayload.albumId = req.body.albumId;
    if (req.body.duration !== undefined) updatePayload.duration = req.body.duration;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.releaseDate !== undefined) updatePayload.releaseDate = SimpleDate.fromJson(req.body.releaseDate);
    if (req.body.format !== undefined) updatePayload.format = AudioFormat.fromJson(req.body.format);

    await AudioTrack.updateById(audioTrackId, updatePayload);
    return res.status(200).json({ message: 'Audio track updated successfully.' });
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
            console.error('Error details:', err);
            res.status(500).json({ message: 'Error streaming audio track', error: err });
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
            if (!res.headersSent) {
                res.status(500).send('Error streaming audio track');
            } else {
                // If headers already sent, just destroy the connection
                res.destroy();
            }
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
export const deleteAudioTrack = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const audioTrackId: string = req.params.audioTrackId;
        const audioTrack = await AudioTrack.findById(audioTrackId);

        if (!audioTrack) {
            return res.status(404).json({ message: 'Audio track not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, audioTrack.createdBy ?? '')) {
            return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
        }

        await AudioTrack.deleteById(audioTrackId);

        let s3CleanupWarning: string | undefined;
        try {
            await getS3().deleteObject({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            }).promise();
        } catch (s3Error) {
            console.log('S3 cleanup failed for audioTrackId:', audioTrackId, s3Error);
            s3CleanupWarning = 'Track metadata was deleted, but deleting the S3 file failed.';
        }

        return res.status(200).json({
            message: 'Audio track deleted successfully.',
            s3CleanupWarning
        });
    } catch (error: any) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to delete audio track.' });
    }
};

// Get an audio track from AWS S3
export const getAudioFile = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;

    
}

export const uploadAudioTrackFile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const audioTrackId: string = req.params.audioTrackId;
        const audioTrack = await AudioTrack.findById(audioTrackId);

        if (!audioTrack) {
            return res.status(404).json({ message: 'Audio track not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, audioTrack.createdBy ?? '')) {
            return res.status(403).json({ message: 'Forbidden: owner or admin only.' });
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return res.status(400).json({ message: 'Missing audio file. Use multipart form field: audioFile.' });
        }

        await getS3().upload({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }).promise();

        return res.status(200).json({
            message: 'Audio file uploaded successfully.',
            audioTrackId
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to upload audio file.' });
    }
};