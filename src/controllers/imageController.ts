import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { getCoverArtObject } from '../services/imageStorageService';

export const getImage = async (req: Request, res: Response, next: NextFunction) => {
    const imageId = String(req.params.imageId ?? '');
    if (!/^[0-9a-f]{24}$/i.test(imageId)) {
        return res.status(400).json({ message: 'Invalid image ID.' });
    }

    try {
        const result = await getCoverArtObject(imageId);
        if (!result) {
            return res.status(404).json({ message: 'Image not found.' });
        }

        const stream = result.object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 image body is not a readable stream.');
        }

        res.setHeader('Content-Type', String(result.asset.contentType));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (result.object.ETag) {
            res.setHeader('ETag', result.object.ETag);
            if (req.headers['if-none-match'] === result.object.ETag) {
                return res.status(304).end();
            }
        }
        if (result.object.ContentLength !== undefined) {
            res.setHeader('Content-Length', result.object.ContentLength);
        }
        stream.on('error', (error) => {
            if (!res.headersSent) {
                next(error);
            } else {
                res.destroy(error);
            }
        });
        return stream.pipe(res);
    } catch (error) {
        return next(error);
    }
};
