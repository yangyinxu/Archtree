import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';

import { getS3 } from '../infrastructure/s3';
import { AudioTrack } from '../models/audioTrack';
import {
    createMediaAbortContext,
    parseSingleByteRange,
    pipeMediaStream,
    shouldHonorRange
} from '../services/mediaDeliveryService';
import {
    activeMediaContentTypeForTrack,
    activeMediaObjectKeyForTrack,
    activeMediaTypeForTrack,
    type MediaType
} from '../utils/mediaStorageKey';

const s3ErrorStatus = (error: any) => {
    const status = Number(error?.$metadata?.httpStatusCode ?? 0);
    return status === 403 ? 403 : status === 404 ? 404 : 502;
};

export interface MediaTrackResolverDependencies {
    findReadyTrack: (mediaTrackId: string) => Promise<any | null>;
    headObject: (
        params: { Bucket: string; Key: string },
        abortSignal: AbortSignal
    ) => Promise<any>;
}

const defaultResolverDependencies: MediaTrackResolverDependencies = {
    findReadyTrack: mediaTrackId => AudioTrack.findReadyPublicById(mediaTrackId),
    headObject: (params, abortSignal) => getS3().send(
        new HeadObjectCommand(params),
        { abortSignal }
    )
};

/** Resolves the one ready object selected by a published MediaTrack row. */
export const resolveReadyMediaTrackAsset = async (
    mediaTrackId: string,
    abortSignal: AbortSignal,
    dependencyOverrides: Partial<MediaTrackResolverDependencies> = {},
    requiredMediaType?: MediaType
) => {
    const dependencies = { ...defaultResolverDependencies, ...dependencyOverrides };
    const normalizedId = String(mediaTrackId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(normalizedId)) return { status: 'notFound' as const };
    const track: any = await dependencies.findReadyTrack(normalizedId);
    if (!track) return { status: 'notFound' as const };

    const mediaType = activeMediaTypeForTrack(track);
    if (requiredMediaType && mediaType !== requiredMediaType) {
        return { status: 'notFound' as const };
    }
    const s3Key = activeMediaObjectKeyForTrack(track);
    if (!s3Key) return { status: 'notFound' as const };

    const params = { Bucket: process.env.S3_BUCKET_NAME!, Key: s3Key };
    const metadata = await dependencies.headObject(params, abortSignal);
    if (!Number.isSafeInteger(metadata.ContentLength) || metadata.ContentLength <= 0) {
        return { status: 'notFound' as const };
    }
    return {
        status: 'ready' as const,
        track,
        mediaType,
        contentType: activeMediaContentTypeForTrack(track),
        params,
        metadata
    };
};

/** Applies full or one exact RFC byte range for either supported media kind. */
export const resolveMediaTrackByteResponse = (
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

type ReadyMediaTrackAsset = Extract<
    Awaited<ReturnType<typeof resolveReadyMediaTrackAsset>>,
    { status: 'ready' }
>;

const setMediaHeaders = (
    res: Response,
    asset: ReadyMediaTrackAsset,
    contentLength: number
) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (asset.metadata.ETag) res.setHeader('ETag', asset.metadata.ETag);
};

export const headMediaTrack = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyMediaTrackAsset(
            req.params.mediaTrackId,
            context.signal
        );
        if (asset.status !== 'ready') return res.status(404).end();
        setMediaHeaders(res, asset, asset.metadata.ContentLength!);
        return res.status(200).end();
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        const status = s3ErrorStatus(error);
        if (status >= 500) console.error('Error checking MediaTrack:', error);
        return res.status(status).end();
    } finally {
        context.cleanup();
    }
};

export const streamMediaTrack = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyMediaTrackAsset(
            req.params.mediaTrackId,
            context.signal
        );
        if (asset.status !== 'ready') return res.status(404).end();

        const fileSize = asset.metadata.ContentLength!;
        const requestedRange = shouldHonorRange(
            typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
            asset.metadata.ETag
        ) ? req.headers.range : undefined;
        const byteResponse = resolveMediaTrackByteResponse(requestedRange, fileSize);
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
        setMediaHeaders(res, asset, end - start + 1);
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${String(asset.track._id)}.${asset.mediaType === 'video' ? 'mp4' : 'media'}"`
        );

        const object = await getS3().send(new GetObjectCommand({
            ...asset.params,
            Range: byteResponse.status === 206 ? `bytes=${start}-${end}` : undefined
        }), { abortSignal: context.signal });
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 media body is not a readable stream.');
        }
        await pipeMediaStream(req, res, stream, context);
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        console.error('Error streaming MediaTrack:', error);
        if (!res.headersSent) return res.status(s3ErrorStatus(error)).end();
        res.destroy(error instanceof Error ? error : undefined);
    } finally {
        context.cleanup();
    }
};
