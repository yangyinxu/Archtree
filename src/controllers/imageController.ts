import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { getCoverArtObject } from '../services/imageStorageService';
import {
    createMediaAbortContext,
    pipeMediaStream
} from '../services/mediaDeliveryService';

export const getImage = async (req: Request, res: Response, next: NextFunction) => {
    const imageId = String(req.params.imageId ?? '');
    if (!/^[0-9a-f]{24}$/i.test(imageId)) {
        return res.status(400).json({ message: 'Invalid image ID.' });
    }

    const context = createMediaAbortContext(req, res);
    try {
        const result = await getCoverArtObject(imageId, {
            ifNoneMatch: req.headers['if-none-match'],
            abortSignal: context.signal
        });
        if (!result) {
            return res.status(404).json({ message: 'Image not found.' });
        }
        if (result.notModified) {
            const requestedEtag = req.headers['if-none-match'];
            if (requestedEtag) {
                res.setHeader('ETag', requestedEtag);
            }
            return res.status(304).end();
        }

        const stream = result.object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 image body is not a readable stream.');
        }

        res.setHeader('Content-Type', String(result.asset.contentType));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Accel-Buffering', 'no');
        if (result.object.ETag) {
            res.setHeader('ETag', result.object.ETag);
        }
        if (result.object.ContentLength !== undefined) {
            res.setHeader('Content-Length', result.object.ContentLength);
        }
        await pipeMediaStream(req, res, stream, context);
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
