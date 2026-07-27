import { NextFunction, Request, Response } from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import {
    createMediaAbortContext,
    parseSingleByteRange,
    pipeMediaStream
} from '../services/mediaDeliveryService';

const gridFsCollection = 'fs.files';
const configuredVideoChunkMb = Number(process.env.MAX_VIDEO_STREAM_CHUNK_MB ?? 4);
const maxVideoChunkBytes = (
    Number.isFinite(configuredVideoChunkMb) && configuredVideoChunkMb > 0
        ? configuredVideoChunkMb
        : 4
) * 1024 * 1024;

const streamVideo = async (
    req: Request,
    res: Response,
    next: NextFunction,
    videoId?: string
) => {
    const db = getDb();
    if (!db) {
        return res.status(503).json({ message: 'Database is unavailable.' });
    }

    if (videoId && !/^[0-9a-f]{24}$/i.test(videoId)) {
        return res.status(400).json({ message: 'Invalid video ID.' });
    }

    const context = createMediaAbortContext(req, res);
    try {
        const query = videoId ? { _id: new ObjectId(videoId) } : {};
        const video = await db.collection(gridFsCollection).findOne(query, { maxTimeMS: 5_000 });
        if (!video) {
            return res.status(404).json({ message: 'Video not found.' });
        }

        const videoSize = Number(video.length);
        const rangeHeader = req.headers.range;
        if (!rangeHeader) {
            res.setHeader('Content-Range', `bytes */${videoSize}`);
            return res.status(416).json({ message: 'A byte Range header is required.' });
        }

        const range = parseSingleByteRange(rangeHeader, videoSize, maxVideoChunkBytes);
        if (!range) {
            res.setHeader('Content-Range', `bytes */${videoSize}`);
            return res.status(416).end();
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${videoSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', range.end - range.start + 1);
        res.setHeader('Content-Type', String(video.contentType || 'video/mp4'));
        res.setHeader('X-Accel-Buffering', 'no');

        const bucket = new GridFSBucket(db);
        const downloadStream = bucket.openDownloadStream(video._id, {
            start: range.start,
            end: range.end + 1
        });
        await pipeMediaStream(req, res, downloadStream, context);
        return;
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        if (res.headersSent) {
            return res.destroy(error instanceof Error ? error : undefined);
        }
        return next(error);
    } finally {
        context.cleanup();
    }
};

export const getVideo = (req: Request, res: Response, next: NextFunction) => {
    return streamVideo(req, res, next);
};

export const getVideoById = (req: Request, res: Response, next: NextFunction) => {
    return streamVideo(req, res, next, req.params.videoId);
};
