import { NextFunction, Request, Response } from 'express';

/**
 * Legacy GridFS files have no catalog ownership mapping. An arbitrary object ID
 * cannot authorize delivery; canonical Video uses the MediaTrack S3 resolver.
 * Keep these routes unavailable until an explicit traced migration exists.
 */
export const getVideo = (_req: Request, res: Response, _next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(404).json({ message: 'Video not found.' });
};
export const getVideoById = getVideo;
