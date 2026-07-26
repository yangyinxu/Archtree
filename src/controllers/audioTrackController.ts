import { Request, Response, NextFunction } from 'express';
import { Readable } from 'node:stream';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { getS3 } from '../infrastructure/s3';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../utils/textEncoding';

const parseJsonField = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

const parseStringArray = (value: unknown) => {
    const parsed = parseJsonField(value);
    if (Array.isArray(parsed)) return parsed.map(String) as [string];
    if (typeof parsed === 'string') {
        return parsed.split(',').map((item) => item.trim()).filter(Boolean) as [string];
    }
    return [] as unknown as [string];
};

// Create a new audio track via the model and save it to the db
export const postAudioTrack = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
    if (!uploadFile) {
        return res.status(400).json({ message: 'An audio file is required. Use multipart form field: audioFile.' });
    }

    const title: string = req.body.title;
    const artistIds = parseStringArray(req.body.artistIds);
    const genres = parseStringArray(req.body.genres);
    const albumId: string = req.body.albumId;
    const releaseDateValue = parseJsonField(req.body.releaseDate);
    const releaseDate = releaseDateValue && typeof releaseDateValue === 'object'
        ? SimpleDate.fromJson(releaseDateValue)
        : new SimpleDate();
    const duration: string = req.body.duration;
    const formatValue = parseJsonField(req.body.format);
    const format = formatValue && typeof formatValue === 'object'
        ? AudioFormat.fromJson(formatValue)
        : new AudioFormat(uploadFile.mimetype.replace(/^audio\//i, '').toUpperCase() || 'AUDIO');
    const coverArtUrl: string = req.body.coverArtUrl;
    const audioTrackObjectId = new ObjectId();
    const audioTrackId = audioTrackObjectId.toHexString();
    const originalFileName = normalizeUtf8Text(uploadFile.originalname);

    const track = new AudioTrack(
        normalizeUtf8Text(title),
        artistIds,
        genres,
        albumId,
        releaseDate,
        duration,
        format,
        coverArtUrl,
        authReq.auth.userId,
        originalFileName,
        uploadFile.mimetype || 'audio/mpeg',
        audioTrackObjectId
    );

    try {
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }));
        try {
            await track.save();
        } catch (databaseError) {
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            })).catch((cleanupError) => {
                console.log('Unable to clean up S3 file after track creation failed:', cleanupError);
            });
            throw databaseError;
        }

        return res.status(201).json({
            message: `Audio Track ${title} Added Successfully`,
            audioTrackId
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to create and upload audio track.' });
    }
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
export const getAudioTrackById = async (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;

    // Fetch the audio track from AWS S3
    try {
        const data = await getS3().send(new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId
        }));
        const body = await data.Body?.transformToByteArray();
        res.status(200).send(Buffer.from(body ?? []));
    } catch (error) {
        console.log(error);
        res.status(500).send('Error fetching audio track from AWS S3');
    }

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
export const streamAudioTrack = async (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;
    const s3 = getS3();
    const params = {
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: audioTrackId
    };

    // Check for Range header
    const range = req.headers.range;
    try {
        const metadata = await s3.send(new HeadObjectCommand(params));
        if (!metadata.ContentLength) {
            console.error('Error getting metadata: missing ContentLength');
            res.status(500).json({ message: 'Error streaming audio track' });
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

        const object = await s3.send(new GetObjectCommand({ ...params, Range: `bytes=${start}-${end}` }));
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 object body is not a readable stream.');
        }
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
    } catch (error) {
        console.error('Error streaming audio track:', error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Error streaming audio track', error });
        } else {
            res.destroy();
        }
    }
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
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            }));
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

        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }));
        await AudioTrack.updateById(audioTrackId, {
            originalFileName: normalizeUtf8Text(uploadFile.originalname),
            contentType: uploadFile.mimetype || 'audio/mpeg'
        });

        return res.status(200).json({
            message: 'Audio file uploaded successfully.',
            audioTrackId
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to upload audio file.' });
    }
};
