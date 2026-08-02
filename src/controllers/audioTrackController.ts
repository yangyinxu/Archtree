import { Request, Response, NextFunction } from 'express';
import { Readable } from 'node:stream';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { Artist } from '../models/artist';
import { SimpleDate } from '../models/simpleDate';
import { getS3 } from '../infrastructure/s3';
import {
    GetObjectCommand,
    HeadObjectCommand
} from '@aws-sdk/client-s3';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../utils/textEncoding';
import {
    deleteAudioObjectAndTrack,
    uploadAudioObject
} from '../services/audioStorageService';
import { validateOwnedContentReferences } from '../services/contentReferenceService';
import { deleteCoverArt, uploadCoverArt } from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';
import {
    attachmentContentDisposition,
    createMediaAbortContext,
    parseSingleByteRange,
    pipeMediaStream,
    shouldHonorRange
} from '../services/mediaDeliveryService';
import { getRequestAbortSignal } from '../middleware/requestProtectionMiddleware';

const s3ErrorStatus = (error: any) => {
    const status = Number(error?.$metadata?.httpStatusCode ?? 0);
    return status === 403 ? 403 : status === 404 ? 404 : 502;
};

/** Resolves only database-confirmed ready assets for authenticated downloads. */
const resolveReadyDownloadAsset = async (
    audioTrackId: string,
    abortSignal: AbortSignal
) => {
    if (!ObjectId.isValid(audioTrackId)) return { status: 'notFound' as const };
    const track: any = await AudioTrack.findById(audioTrackId);
    if (!track) return { status: 'notFound' as const };
    if (track.uploadStatus !== 'ready') return { status: 'notReady' as const };

    const s3Key = String(track.s3Key ?? '').trim();
    if (!s3Key) return { status: 'notReady' as const };
    const params = {
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: s3Key
    };
    const metadata = await getS3().send(
        new HeadObjectCommand(params),
        { abortSignal }
    );
    if (!metadata.ContentLength) return { status: 'notReady' as const };

    return { status: 'ready' as const, track, params, metadata };
};

const setDownloadHeaders = (
    res: Response,
    asset: Extract<Awaited<ReturnType<typeof resolveReadyDownloadAsset>>, { status: 'ready' }>,
    contentLength: number
) => {
    const { track, metadata } = asset;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', metadata.ContentType || track.contentType || 'audio/mpeg');
    res.setHeader('Content-Length', contentLength);
    res.setHeader(
        'Content-Disposition',
        attachmentContentDisposition(track.originalFileName, String(track._id))
    );
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (metadata.ETag) res.setHeader('ETag', metadata.ETag);
};

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

    const uploadFile = getUploadedFile(req, 'audioFile');
    if (!uploadFile) {
        return res.status(400).json({ message: 'An audio file is required. Use multipart form field: audioFile.' });
    }

    const title: string = req.body.title;
    const artistIds = parseStringArray(req.body.artistIds);
    if (!artistIds[0]) {
        return res.status(400).json({ message: 'At least one artistId is required.' });
    }

    let artists: any[];
    try {
        artists = await Promise.all(artistIds.map((artistId) => Artist.findById(artistId)));
    } catch {
        return res.status(400).json({ message: 'One or more artistIds are invalid.' });
    }
    if (artists.some((artist) => !artist)) {
        return res.status(404).json({ message: 'One or more artists were not found.' });
    }
    if (artists.some((artist) => !ensureOwnerOrAdmin(authReq, String(artist.createdBy ?? '')))) {
        return res.status(403).json({ message: 'One or more artists cannot be modified by this user.' });
    }

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
        await track.save();
        await uploadAudioObject(audioTrackId, uploadFile, authReq.auth.userId, getRequestAbortSignal(req));
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            await AudioTrack.updateById(audioTrackId, {
                coverArtId: coverArt.imageId,
                coverArtUrl: coverArt.coverArtUrl
            });
        }

        return res.status(201).json({
            message: `Audio Track ${title} Added Successfully`,
            audioTrackId,
            uploadStatus: 'ready'
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({
            message: 'Failed to create and upload audio track. The upload attempt remains recorded for reconciliation.',
            audioTrackId
        });
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
    const coverArtFile = getUploadedFile(req, 'coverArtFile');
    let replacementCoverArtId: string | undefined;
    if (req.body.title !== undefined) updatePayload.title = req.body.title;
    if (req.body.artistIds !== undefined) {
        const artistIds = parseStringArray(req.body.artistIds);
        if (!artistIds[0]) {
            return res.status(400).json({ message: 'At least one artistId is required.' });
        }
        const validation = await validateOwnedContentReferences(authReq, 'artist', artistIds);
        if (!validation.valid) {
            return res.status(400).json({ message: validation.message });
        }
        updatePayload.artistIds = validation.ids;
    }
    if (req.body.genres !== undefined) updatePayload.genres = req.body.genres;
    if (req.body.albumId !== undefined) {
        const albumId = String(req.body.albumId ?? '').trim();
        if (albumId) {
            const validation = await validateOwnedContentReferences(authReq, 'album', [albumId]);
            if (!validation.valid) {
                return res.status(400).json({ message: validation.message });
            }
            updatePayload.albumId = validation.ids[0];
        } else {
            updatePayload.albumId = '';
        }
    }
    if (req.body.duration !== undefined) updatePayload.duration = req.body.duration;
    if (req.body.coverArtUrl !== undefined) updatePayload.coverArtUrl = req.body.coverArtUrl;
    if (req.body.releaseDate !== undefined) updatePayload.releaseDate = SimpleDate.fromJson(req.body.releaseDate);
    if (req.body.format !== undefined) updatePayload.format = AudioFormat.fromJson(req.body.format);

    if (coverArtFile) {
        const coverArt = await uploadCoverArt(
            'audioTrack',
            audioTrackId,
            coverArtFile,
            authReq.auth.userId
        );
        replacementCoverArtId = coverArt.imageId;
        updatePayload.coverArtId = coverArt.imageId;
        updatePayload.coverArtUrl = coverArt.coverArtUrl;
    } else if (String(req.body.removeCoverArt ?? '').toLowerCase() === 'true') {
        await deleteCoverArt(audioTrack.coverArtId);
        updatePayload.coverArtId = null;
        updatePayload.coverArtUrl = '';
    }

    await AudioTrack.updateById(audioTrackId, updatePayload);
    let cleanupPending = false;
    if (replacementCoverArtId && audioTrack.coverArtId && audioTrack.coverArtId !== replacementCoverArtId) {
        await deleteCoverArt(audioTrack.coverArtId).catch((error) => {
            cleanupPending = true;
            console.log(`Unable to delete replaced audio-track cover art ${audioTrack.coverArtId}:`, error);
        });
    }
    return res.status(200).json({ message: 'Audio track updated successfully.', cleanupPending });
};

// Get an audio track via the model and return it
export const getAudioTrackById = async (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;
    return res.redirect(
        307,
        `/content/audioTrack/stream/${encodeURIComponent(audioTrackId)}`
    );
};

// Stream an audio track by id from AWS S3 with support for HTTP Range requests
export const headAudioTrackStream = async (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId = req.params.audioTrackId;
    const context = createMediaAbortContext(req, res);
    try {
        const metadata = await getS3().send(new HeadObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId
        }), { abortSignal: context.signal });
        if (metadata.ContentLength === undefined) {
            return res.status(404).end();
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', metadata.ContentType || 'audio/mpeg');
        res.setHeader('Content-Length', metadata.ContentLength);
        if (metadata.ETag) res.setHeader('ETag', metadata.ETag);
        return res.status(200).end();
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        const statusCode = s3ErrorStatus(error);
        if (statusCode >= 500) {
            console.error('Error checking audio track:', error);
        }
        return res.status(statusCode).end();
    } finally {
        context.cleanup();
    }
};

export const streamAudioTrack = async (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;
    const s3 = getS3();
    const params = {
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: audioTrackId
    };

    const range = req.headers.range;
    const context = createMediaAbortContext(req, res);
    try {
        const metadata = await s3.send(
            new HeadObjectCommand(params),
            { abortSignal: context.signal }
        );
        if (!metadata.ContentLength) {
            return res.status(404).end();
        }

        const fileSize = metadata.ContentLength;
        let start = 0;
        let end = fileSize - 1;

        if (range) {
            // AVPlayer commonly sends open-ended or suffix ranges. Return the exact
            // satisfiable range it requested; truncating it to an arbitrary chunk
            // changes HTTP range semantics and can make the player reject the asset.
            const parsedRange = parseSingleByteRange(range, fileSize, fileSize);
            if (!parsedRange) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).end();
            }
            start = parsedRange.start;
            end = parsedRange.end;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        } else {
            res.status(200);
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', metadata.ContentType || 'audio/mpeg');
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Disposition', `inline; filename="${audioTrackId}"`);
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-transform');
        if (metadata.ETag) res.setHeader('ETag', metadata.ETag);

        const object = await s3.send(
            new GetObjectCommand({
                ...params,
                Range: range ? `bytes=${start}-${end}` : undefined
            }),
            { abortSignal: context.signal }
        );
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 object body is not a readable stream.');
        }
        await pipeMediaStream(req, res, stream, context);
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        console.error('Error streaming audio track:', error);
        if (!res.headersSent) {
            return res.status(s3ErrorStatus(error)).json({ message: 'Unable to stream audio track.' });
        } else {
            res.destroy(error instanceof Error ? error : undefined);
        }
    } finally {
        context.cleanup();
    }
};

export const headAudioTrackDownload = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyDownloadAsset(
            req.params.audioTrackId,
            context.signal
        );
        if (asset.status === 'notFound') return res.status(404).end();
        if (asset.status === 'notReady') return res.status(409).end();

        setDownloadHeaders(res, asset, asset.metadata.ContentLength!);
        return res.status(200).end();
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        const statusCode = s3ErrorStatus(error);
        if (statusCode >= 500) {
            console.error('Error checking downloadable audio track:', error);
        }
        return res.status(statusCode).end();
    } finally {
        context.cleanup();
    }
};

/** Downloads one ready audio asset with validator-aware resumable ranges. */
export const downloadAudioTrack = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const context = createMediaAbortContext(req, res);
    try {
        const asset = await resolveReadyDownloadAsset(
            req.params.audioTrackId,
            context.signal
        );
        if (asset.status === 'notFound') {
            return res.status(404).json({ message: 'Audio track not found.' });
        }
        if (asset.status === 'notReady') {
            return res.status(409).json({ message: 'Audio track is not ready for download.' });
        }

        const fileSize = asset.metadata.ContentLength!;
        const requestedRange = req.headers.range;
        const ifRange = typeof req.headers['if-range'] === 'string'
            ? req.headers['if-range']
            : undefined;
        const effectiveRange = requestedRange && shouldHonorRange(
            ifRange,
            asset.metadata.ETag
        ) ? requestedRange : undefined;
        let start = 0;
        let end = fileSize - 1;

        if (effectiveRange) {
            const parsedRange = parseSingleByteRange(
                effectiveRange,
                fileSize,
                fileSize
            );
            if (!parsedRange) {
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                if (asset.metadata.ETag) res.setHeader('ETag', asset.metadata.ETag);
                return res.status(416).end();
            }
            start = parsedRange.start;
            end = parsedRange.end;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        } else {
            res.status(200);
        }

        setDownloadHeaders(res, asset, end - start + 1);
        const object = await getS3().send(
            new GetObjectCommand({
                ...asset.params,
                Range: effectiveRange ? `bytes=${start}-${end}` : undefined
            }),
            { abortSignal: context.signal }
        );
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 object body is not a readable stream.');
        }
        await pipeMediaStream(req, res, stream, context);
    } catch (error: any) {
        if (context.aborted || error?.name === 'AbortError') return;
        console.error('Error downloading audio track:', error);
        if (!res.headersSent) {
            return res.status(s3ErrorStatus(error)).json({
                message: 'Unable to download audio track.'
            });
        }
        res.destroy(error instanceof Error ? error : undefined);
    } finally {
        context.cleanup();
    }
};

// Get all audio tracks via the model and return them
export const getAudioTracks = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const audioTracks = await AudioTrack.fetchAll(limit, offset);
        return res.status(200).json({ audioTracks, limit, offset });
    } catch (error) {
        return next(error);
    }
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

        try {
            await deleteAudioObjectAndTrack(audioTrackId);
        } catch (s3Error) {
            console.log('Audio track deletion failed for audioTrackId:', audioTrackId, s3Error);
            return res.status(502).json({
                message: 'The S3 file could not be deleted. Track metadata was retained for reconciliation.'
            });
        }

        return res.status(200).json({
            message: 'Audio track deleted successfully.'
        });
    } catch (error: any) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to delete audio track.' });
    }
};

// Get an audio track from AWS S3
export const getAudioFile = (req: Request, res: Response, next: NextFunction) => {
    const audioTrackId: string = req.params.audioTrackId;
    return res.redirect(
        307,
        `/content/audioTrack/stream/${encodeURIComponent(audioTrackId)}`
    );
};

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

        await uploadAudioObject(audioTrackId, uploadFile, String(audioTrack.createdBy ?? authReq.auth.userId), getRequestAbortSignal(req));

        return res.status(200).json({
            message: 'Audio file uploaded successfully.',
            audioTrackId,
            uploadStatus: 'ready'
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Failed to upload audio file.' });
    }
};
