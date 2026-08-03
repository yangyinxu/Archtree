import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';
import {
    getCoverArtObject,
    getCoverArtVariant,
    isCoverArtVariantWidth
} from '../services/imageStorageService';
import {
    createMediaAbortContext,
    pipeMediaStream
} from '../services/mediaDeliveryService';

export const catalogArtworkCacheControl = 'public, no-cache';

const requestEtag = (req: Request) => {
    const value = req.headers['if-none-match'];
    return Array.isArray(value) ? value.join(',') : value;
};

export const getImage = async (req: Request, res: Response, next: NextFunction) => {
    const imageId = String(req.params.imageId ?? '');
    if (!/^[0-9a-f]{24}$/i.test(imageId)) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(400).json({ message: 'Invalid image ID.' });
    }

    const context = createMediaAbortContext(req, res);
    try {
        const result = await getCoverArtObject(imageId, {
            ifNoneMatch: req.headers['if-none-match'],
            abortSignal: context.signal
        });
        if (!result) {
            res.setHeader('Cache-Control', 'private, no-store');
            return res.status(404).json({ message: 'Image not found.' });
        }
        res.setHeader('Cache-Control', catalogArtworkCacheControl);
        if (result.notModified) {
            if (result.etag) res.setHeader('ETag', result.etag);
            return res.status(304).end();
        }

        const stream = result.object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 image body is not a readable stream.');
        }

        res.setHeader('Content-Type', String(result.asset.contentType));
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

export interface ImageVariantControllerDependencies {
    getVariant?: typeof getCoverArtVariant;
}

/** Creates the fixed-width derivative handler with injectable storage work for tests. */
export const createGetImageVariant = (
    dependencies: ImageVariantControllerDependencies = {}
) => {
    const getVariant = dependencies.getVariant ?? getCoverArtVariant;
    return async (req: Request, res: Response, next: NextFunction) => {
        const imageId = String(req.params.imageId ?? '');
        const widthValue = String(req.params.width ?? '');
        if (!/^[0-9a-f]{24}$/i.test(imageId)) {
            res.setHeader('Cache-Control', 'private, no-store');
            return res.status(400).json({ message: 'Invalid image ID.' });
        }
        if (!isCoverArtVariantWidth(widthValue)) {
            res.setHeader('Cache-Control', 'private, no-store');
            return res.status(400).json({ message: 'Unsupported cover-art width.' });
        }

        const context = createMediaAbortContext(req, res);
        try {
            const result = await getVariant(imageId, Number(widthValue), {
                ifNoneMatch: requestEtag(req),
                abortSignal: context.signal,
                clientKey: req.ip || req.socket?.remoteAddress || 'unknown'
            }, {
                attachSource: context.attachSource
            });
            if (context.aborted) return;
            if (!result) {
                res.setHeader('Cache-Control', 'private, no-store');
                return res.status(404).json({ message: 'Image not found.' });
            }

            res.setHeader('Cache-Control', catalogArtworkCacheControl);
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('ETag', result.etag);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (result.notModified) {
                return res.status(304).end();
            }
            if (!result.body) {
                throw new Error('Cover-art variant body is missing.');
            }
            res.setHeader('Content-Length', result.body.length);
            return res.status(200).end(result.body);
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
};

export const getImageVariant = createGetImageVariant();
