import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';

import { getS3 } from '../infrastructure/s3';
import { AudioTrack } from '../models/audioTrack';
import {
    isMediaRepresentationRevision,
    roomAudioRepresentationForTrack,
    storedMediaRepresentationForTrack
} from '../services/mediaRepresentationService';
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
    return status === 403 ? 403 : status === 404 || status === 412 ? 404 : 502;
};

export interface MediaTrackResolverDependencies {
    findReadyTrack: (mediaTrackId: string) => Promise<any | null>;
    headObject: (
        params: { Bucket: string; Key: string; IfMatch?: string; VersionId?: string },
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
    requiredMediaType?: MediaType,
    expectedRevision?: string
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
    const pinned = expectedRevision === undefined ? null : storedMediaRepresentationForTrack(track);
    if (expectedRevision !== undefined && (!pinned || pinned.revision !== expectedRevision)) {
        return { status: 'notFound' as const };
    }
    const params = {
        Bucket: process.env.S3_BUCKET_NAME!, Key: s3Key,
        ...(pinned ? { IfMatch: pinned.etag!, ...(pinned.versionId ? { VersionId: pinned.versionId } : {}) } : {})
    };
    const metadata = await dependencies.headObject(params, abortSignal);
    if (!Number.isSafeInteger(metadata.ContentLength) || metadata.ContentLength <= 0) {
        return { status: 'notFound' as const };
    }
    if (pinned) {
        if (metadata.ETag !== pinned.etag || metadata.ContentLength !== pinned.byteLength
            || (pinned.versionId && metadata.VersionId !== pinned.versionId)) return { status: 'notFound' as const };
        // Replacement or deletion while HEAD was pending must not open an obsolete representation.
        const current = await dependencies.findReadyTrack(normalizedId);
        const currentRepresentation = storedMediaRepresentationForTrack(current);
        if (!currentRepresentation || currentRepresentation.revision !== pinned.revision
            || currentRepresentation.objectKey !== pinned.objectKey
            || currentRepresentation.etag !== pinned.etag
            || currentRepresentation.versionId !== pinned.versionId) return { status: 'notFound' as const };
    }
    return {
        status: 'ready' as const,
        track,
        mediaType,
        // A verified pinned source determines its type even when an old upload declared a misleading MIME.
        contentType: pinned && roomAudioRepresentationForTrack(track)
            ? ({ 'wav-pcm': 'audio/wav', mp3: 'audio/mpeg', 'm4a-aac': 'audio/mp4' } as Record<string, string>)[pinned.format]
            : activeMediaContentTypeForTrack(track),
        params,
        metadata,
        pinned
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
    res.setHeader('Cache-Control', asset.pinned ? 'no-store, no-transform' : 'no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (asset.metadata.ETag) res.setHeader('ETag', asset.metadata.ETag);
};

export const headMediaTrack = async (
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    const revision = req.query.revision;
    if (revision !== undefined && !isMediaRepresentationRevision(revision)) return res.status(400).end();
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyMediaTrackAsset(
            req.params.mediaTrackId,
            context.signal, {}, undefined, revision
        );
        if (asset.status !== 'ready') return res.status(404).end();
        setMediaHeaders(res, asset, asset.metadata.ContentLength!);
        return res.status(200).end();
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        const status = s3ErrorStatus(error);
        if (status >= 500) console.error('Error checking MediaTrack.');
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
    const revision = req.query.revision;
    if (revision !== undefined && !isMediaRepresentationRevision(revision)) return res.status(400).end();
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyMediaTrackAsset(
            req.params.mediaTrackId,
            context.signal, {}, undefined, revision
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
        const object = await getS3().send(new GetObjectCommand({
            ...asset.params,
            Range: byteResponse.status === 206 ? `bytes=${start}-${end}` : undefined
        }), { abortSignal: context.signal });
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 media body is not a readable stream.');
        }
        if (asset.pinned && (object.ETag !== asset.pinned.etag
            || (asset.pinned.versionId && object.VersionId !== asset.pinned.versionId)
            || object.ContentLength !== end - start + 1)) {
            stream.destroy();
            return res.status(404).end();
        }
        res.status(byteResponse.status);
        if (byteResponse.status === 206) res.setHeader('Content-Range', byteResponse.contentRange);
        setMediaHeaders(res, asset, end - start + 1);
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${String(asset.track._id)}.${asset.mediaType === 'video' ? 'mp4' : 'media'}"`
        );
        await pipeMediaStream(req, res, stream, context);
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        console.error('Error streaming MediaTrack.');
        if (!res.headersSent) return res.status(s3ErrorStatus(error)).end();
        res.destroy(error instanceof Error ? error : undefined);
    } finally {
        context.cleanup();
    }
};
