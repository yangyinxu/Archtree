import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';

import { getS3 } from '../infrastructure/s3';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { getRequestAbortSignal } from '../middleware/requestProtectionMiddleware';
import { AudioTrack } from '../models/audioTrack';
import {
    createMediaAbortContext,
    parseSingleByteRange,
    pipeMediaStream,
    shouldHonorRange
} from '../services/mediaDeliveryService';
import {
    AudioStorageLifecycleError,
    uploadVideoObject
} from '../services/audioStorageService';
import {
    InvalidSoundtrackVideoError,
    validateSoundtrackVideoFile
} from '../services/videoMetadataService';
import { readyVideoObjectKey } from '../utils/videoStorageKey';

const s3ErrorStatus = (error: any) => {
    const status = Number(error?.$metadata?.httpStatusCode ?? 0);
    return status === 403 ? 403 : status === 404 ? 404 : 502;
};

export interface SoundtrackVideoResolverDependencies {
    findReadyTrack: (audioTrackId: string) => Promise<any | null>;
    headObject: (
        params: { Bucket: string; Key: string },
        abortSignal: AbortSignal
    ) => Promise<any>;
}

const defaultResolverDependencies: SoundtrackVideoResolverDependencies = {
    findReadyTrack: audioTrackId => AudioTrack.findReadyPublicById(audioTrackId),
    headObject: (params, abortSignal) => getS3().send(
        new HeadObjectCommand(params),
        { abortSignal }
    )
};

/** Resolves video bytes only through a published MediaTrack and its active lifecycle key. */
export const resolveReadyVideoAsset = async (
    audioTrackId: string,
    abortSignal: AbortSignal,
    dependencyOverrides: Partial<SoundtrackVideoResolverDependencies> = {}
) => {
    const dependencies = { ...defaultResolverDependencies, ...dependencyOverrides };
    const normalizedId = String(audioTrackId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(normalizedId)) return { status: 'notFound' as const };
    const track: any = await dependencies.findReadyTrack(normalizedId);
    if (!track) return { status: 'notFound' as const };
    const s3Key = readyVideoObjectKey(track);
    if (!s3Key) return { status: 'notFound' as const };
    const params = { Bucket: process.env.S3_BUCKET_NAME!, Key: s3Key };
    const metadata = await dependencies.headObject(params, abortSignal);
    if (!metadata.ContentLength) return { status: 'notFound' as const };
    return { status: 'ready' as const, track, params, metadata };
};

const setVideoHeaders = (
    res: Response,
    asset: Extract<Awaited<ReturnType<typeof resolveReadyVideoAsset>>, { status: 'ready' }>,
    contentLength: number
) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (asset.metadata.ETag) res.setHeader('ETag', asset.metadata.ETag);
};

/** Applies normal full-response or exact single-range semantics without chunk truncation. */
export const resolveVideoByteResponse = (
    requestedRange: string | undefined,
    fileSize: number
) => {
    if (!requestedRange) {
        return { status: 200 as const, start: 0, end: fileSize - 1 };
    }
    const parsed = parseSingleByteRange(requestedRange, fileSize, fileSize);
    if (!parsed) {
        return {
            status: 416 as const,
            start: null,
            end: null,
            contentRange: `bytes */${fileSize}`
        };
    }
    return {
        status: 206 as const,
        start: parsed.start,
        end: parsed.end,
        contentRange: `bytes ${parsed.start}-${parsed.end}/${fileSize}`
    };
};

export const headSoundtrackVideo = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyVideoAsset(req.params.audioTrackId, context.signal);
        if (asset.status !== 'ready') return res.status(404).end();
        setVideoHeaders(res, asset, asset.metadata.ContentLength!);
        return res.status(200).end();
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        const status = s3ErrorStatus(error);
        if (status >= 500) console.error('Error checking MediaTrack video:', error);
        return res.status(status).end();
    } finally {
        context.cleanup();
    }
};

export const streamSoundtrackVideo = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyVideoAsset(req.params.audioTrackId, context.signal);
        if (asset.status !== 'ready') return res.status(404).end();

        const fileSize = asset.metadata.ContentLength!;
        const requestedRange = shouldHonorRange(
            typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
            asset.metadata.ETag
        ) ? req.headers.range : undefined;
        const byteResponse = resolveVideoByteResponse(requestedRange, fileSize);
        if (byteResponse.status === 416) {
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Range', byteResponse.contentRange);
            return res.status(416).end();
        }
        const { start, end } = byteResponse;
        res.status(byteResponse.status);
        if (byteResponse.status === 206) {
            res.setHeader('Content-Range', byteResponse.contentRange);
        }

        setVideoHeaders(res, asset, end - start + 1);
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${String(asset.track._id)}.mp4"`
        );
        const object = await getS3().send(new GetObjectCommand({
            ...asset.params,
            Range: byteResponse.status === 206 ? `bytes=${start}-${end}` : undefined
        }), { abortSignal: context.signal });
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 video body is not a readable stream.');
        }
        await pipeMediaStream(req, res, stream, context);
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        console.error('Error streaming MediaTrack video:', error);
        if (!res.headersSent) return res.status(s3ErrorStatus(error)).end();
        res.destroy(error instanceof Error ? error : undefined);
    } finally {
        context.cleanup();
    }
};

export const uploadSoundtrackVideoFile = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) return res.status(401).json({ message: 'Unauthorized' });
    if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }
    const audioTrackId = String(req.params.audioTrackId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(audioTrackId)) {
        return res.status(400).json({ message: 'MediaTrack ID is invalid.' });
    }
    const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
    if (!uploadFile) {
        return res.status(400).json({
            message: 'Missing video file. Use multipart form field: videoFile.'
        });
    }
    try {
        await validateSoundtrackVideoFile(uploadFile);
        const track: any = await AudioTrack.findById(audioTrackId);
        if (!track) return res.status(404).json({ message: 'MediaTrack was not found.' });
        const result = await uploadVideoObject(
            audioTrackId,
            uploadFile,
            String(track.createdBy ?? auth.userId),
            getRequestAbortSignal(req)
        );
        return res.status(200).json({
            message: 'MediaTrack was replaced with Video successfully.',
            mediaType: 'video',
            uploadStatus: 'ready',
            cleanupPending: result.cleanupPending
        });
    } catch (error) {
        const status = error instanceof InvalidSoundtrackVideoError
            ? error.statusCode
            : error instanceof AudioStorageLifecycleError
                ? error.statusCode
                : 500;
        return res.status(status).json({
            message: status >= 500
                ? 'MediaTrack Video replacement could not complete.'
                : String((error as Error).message),
            cleanupPending: error instanceof AudioStorageLifecycleError
                ? error.cleanupPending
                : false
        });
    }
};

export const deleteSoundtrackVideoFile = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) return res.status(401).json({ message: 'Unauthorized' });
    if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }
    return res.status(409).json({
        message: 'A MediaTrack must keep one media object. Replace Video with Audio, or delete the MediaTrack.'
    });
};
