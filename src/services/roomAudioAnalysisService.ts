import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectId, type Db } from 'mongodb';
import type { RoomAudioAnalysisInput, RoomAudioAnalysisItem, RoomAudioAnalysisOutcome,
    RoomAudioAnalysisPage, RoomAudioAnalysisReason } from '../contracts/roomAudioAnalysis';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import { ROOM_AUDIO_ANALYSIS_VERSION, type MediaRepresentation } from '../models/mediaRepresentation';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../utils/mediaStorageKey';
import { roomAudioRepresentationForTrack, storedMediaRepresentationForTrack } from './mediaRepresentationService';
import { inspectRoomAudioFile, RoomAudioInspectionError } from './roomAudioInspection';

export { ROOM_AUDIO_ANALYSIS_VERSION } from '../models/mediaRepresentation';
const maximumBytes = 512 * 1024 * 1024;
const analysisTimeoutMs = 90_000;
const leaseMs = 120_000;
const id = /^[a-f0-9]{24}$/;
const fingerprint = /^[a-f0-9]{64}$/;
const attempt = /^[a-f0-9]{32}$/;
const terminal = new Set(['complete', 'unsupported', 'failed', 'cancelled', 'stale']);
const reasons = new Set<RoomAudioAnalysisReason>(['unsupported_audio', 'decoder_unavailable', 'analysis_timeout',
    'analysis_failed', 'storage_unavailable', 'source_changed', 'cancelled', 'interrupted']);

/** A safe operational error; neither provider diagnostics nor source keys reach the administrator response. */
export class RoomAudioAnalysisError extends Error {
    constructor(public readonly statusCode: number, public readonly code: string) { super(code); }
}

/** Private attempt evidence is embedded in its track and disappears with the normal track deletion lifecycle. */
interface AnalysisAttempt {
    version: number;
    attemptId: string;
    sourceRevision: string;
    objectKey: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    state: 'running' | 'complete' | 'unsupported' | 'failed' | 'cancelled' | 'stale';
    reason: RoomAudioAnalysisReason | null;
    updatedAt: Date;
    resultRevision?: string;
}

/** Isolates decoding and infrastructure for real database/storage race tests. */
export interface RoomAudioAnalysisDependencies {
    database: () => Db;
    storage: () => S3Client;
    inspect: typeof inspectRoomAudioFile;
    now: () => number;
}

const sourceFor = (track: any) => {
    if (!track || typeof track !== 'object') return null;
    const objectKey = activeMediaObjectKeyForTrack(track);
    if (!objectKey || activeMediaTypeForTrack(track) !== 'audio' || track.uploadStatus !== 'ready'
        || track.publicationStatus !== undefined && track.publicationStatus !== 'ready'
        || track.pendingS3Key != null || track.storageCleanupS3Key != null) return null;
    const representation = storedMediaRepresentationForTrack(track);
    // Malformed existing evidence must be reconciled explicitly, never overwritten by a repair guess.
    if (track.mediaRepresentation != null && !representation) return null;
    const prior = track.mediaRepresentation ?? null;
    const sourceRevision = createHash('sha256').update(JSON.stringify({
        version: ROOM_AUDIO_ANALYSIS_VERSION, trackId: String(track._id), objectKey,
        mediaType: track.mediaType ?? null, representation: representation ? {
            revision: representation.revision, byteLength: representation.byteLength, etag: representation.etag,
            versionId: representation.versionId
        } : null
    })).digest('hex');
    return { objectKey, representation, prior, sourceRevision };
};

const recordedAttempt = (track: any): AnalysisAttempt | null => {
    const value = track?.roomAudioAnalysis;
    if (!value || value.version !== ROOM_AUDIO_ANALYSIS_VERSION || typeof value.attemptId !== 'string' || !attempt.test(value.attemptId)
        || typeof value.sourceRevision !== 'string' || !fingerprint.test(value.sourceRevision) || typeof value.objectKey !== 'string'
        || typeof value.leaseToken !== 'string' || !attempt.test(value.leaseToken) || !(value.leaseExpiresAt instanceof Date)
        || !Number.isFinite(value.leaseExpiresAt.getTime()) || !(value.updatedAt instanceof Date)
        || !Number.isFinite(value.updatedAt.getTime()) || !(value.state === 'running' || terminal.has(value.state))
        || value.reason !== null && !reasons.has(value.reason)) return null;
    return value;
};

const sourceFilter = (track: any, source: NonNullable<ReturnType<typeof sourceFor>>) => ({
    _id: track._id, ...readyAudioStorageFilter, s3Key: source.objectKey,
    mediaType: track.mediaType ?? null, videoAsset: track.videoAsset ?? null, pendingS3Key: null, storageCleanupS3Key: null,
    mediaRepresentation: source.prior
});

const projection = (track: any, now: number): RoomAudioAnalysisItem => {
    const source = sourceFor(track);
    const previous = recordedAttempt(track);
    const relevant = previous && source && (previous.sourceRevision === source.sourceRevision
        || previous.resultRevision && (previous.resultRevision ? previous.resultRevision === source.representation?.revision : previous.sourceRevision === source.sourceRevision)) ? previous : null;
    let status: RoomAudioAnalysisItem['status'] = 'notAnalyzed';
    let reason: RoomAudioAnalysisReason | null = null;
    if (roomAudioRepresentationForTrack(track)) status = 'eligible';
    else if (!source) status = 'unavailable';
    else if (relevant?.state === 'running') {
        status = relevant.leaseExpiresAt.getTime() > now ? 'running' : 'retryable';
        if (status === 'retryable') reason = 'interrupted';
    } else if (relevant?.state === 'unsupported') { status = 'unsupported'; reason = 'unsupported_audio'; }
    else if (relevant && ['failed', 'cancelled', 'stale'].includes(relevant.state)) {
        status = 'retryable'; reason = relevant.reason;
    }
    else if (source.representation?.analysisFailure && reasons.has(source.representation.analysisFailure)) {
        status = 'retryable'; reason = source.representation.analysisFailure;
    } else if (source.representation?.analysisVersion === ROOM_AUDIO_ANALYSIS_VERSION
        && source.representation.format === 'unsupported') { status = 'unsupported'; reason = 'unsupported_audio'; }
    return { mediaTrackId: String(track._id), title: String(track.title ?? 'Audio').slice(0, 300), status,
        sourceRevision: source?.sourceRevision ?? '', attemptId: relevant?.attemptId ?? randomBytes(16).toString('hex'),
        updatedAt: relevant?.updatedAt.toISOString() ?? null, reason };
};

/** Explicit source-scoped analysis never uploads, deletes, or mutates media bytes. */
export const createRoomAudioAnalysisService = (overrides: Partial<RoomAudioAnalysisDependencies> = {}) => {
    const dependencies: RoomAudioAnalysisDependencies = { database: () => getDb()!, storage: getS3,
        inspect: inspectRoomAudioFile, now: Date.now, ...overrides };
    let active = false;
    const tracks = () => dependencies.database().collection('audioTracks');
    const assertAdmin = async (actorId: string) => {
        if (!id.test(actorId)) throw new RoomAudioAnalysisError(403, 'admin_required');
        const actor = await dependencies.database().collection('users').findOne({ _id: new ObjectId(actorId), role: 'admin' },
            { projection: { _id: 1 }, maxTimeMS: 5_000 });
        if (!actor) throw new RoomAudioAnalysisError(403, 'admin_required');
    };
    const read = (mediaTrackId: string) => tracks().findOne({ _id: new ObjectId(mediaTrackId) }, { maxTimeMS: 5_000 });
    const list = async (input: { actorId: string; after?: string; limit?: number }): Promise<RoomAudioAnalysisPage> => {
        await assertAdmin(input.actorId);
        const limit = input.limit ?? 25;
        if (input.after !== undefined && !id.test(input.after) || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new RoomAudioAnalysisError(400, 'invalid_analysis_request');
        const rows = await tracks().find({ ...readyAudioStorageFilter,
            _id: { $type: 'objectId', ...(input.after ? { $gt: new ObjectId(input.after) } : {}) }
        }, { projection: { title: 1, s3Key: 1, mediaType: 1, videoAsset: 1, uploadStatus: 1, publicationStatus: 1,
            pendingS3Key: 1, storageCleanupS3Key: 1, mediaRepresentation: 1, roomAudioAnalysis: 1 }, maxTimeMS: 5_000 })
            .sort({ _id: 1 }).limit(limit + 1).toArray();
        return { items: rows.slice(0, limit).filter(track => activeMediaTypeForTrack(track) === 'audio')
            .map(track => projection(track, dependencies.now())),
            nextAfter: rows.length > limit ? String(rows[limit - 1]._id) : null };
    };
    const analyze = async (input: RoomAudioAnalysisInput): Promise<RoomAudioAnalysisOutcome> => {
        await assertAdmin(input.actorId);
        if (!id.test(input.mediaTrackId) || !fingerprint.test(input.sourceRevision) || !attempt.test(input.attemptId))
            throw new RoomAudioAnalysisError(400, 'invalid_analysis_request');
        const outcome = (value: RoomAudioAnalysisOutcome['outcome'], reason: RoomAudioAnalysisReason | null = null): RoomAudioAnalysisOutcome =>
            ({ mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: value, reason });
        if (input.signal?.aborted) return outcome('cancelled', 'cancelled');
        const track = await read(input.mediaTrackId);
        const source = sourceFor(track);
        if (!track || !source) return outcome('stale', 'source_changed');
        const previous = recordedAttempt(track);
        // Resolve the same completed intent before comparing its pre-analysis source fingerprint.
        if (previous?.attemptId === input.attemptId && previous.sourceRevision === input.sourceRevision
            && (previous.resultRevision ? previous.resultRevision === source.representation?.revision : previous.sourceRevision === source.sourceRevision) && previous.objectKey === source.objectKey
            && (previous.state === 'complete' || previous.state === 'unsupported')) return outcome(previous.state, previous.reason);
        if (source.sourceRevision !== input.sourceRevision) return outcome('stale', 'source_changed');
        if (roomAudioRepresentationForTrack(track)) return outcome('complete');
        // A newly listed fingerprint or upload-time result cannot reopen a terminal unsupported source.
        if (projection(track, dependencies.now()).status === 'unsupported') return outcome('unsupported', 'unsupported_audio');
        if (active || previous?.sourceRevision === source.sourceRevision && previous.state === 'running' && previous.leaseExpiresAt.getTime() > dependencies.now()) return outcome('busy');
        if (previous?.sourceRevision === input.sourceRevision && previous.attemptId !== input.attemptId)
            return outcome('stale', 'source_changed');
        active = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        const timeout = setTimeout(abort, analysisTimeoutMs);
        const leaseToken = randomBytes(16).toString('hex');
        const record: AnalysisAttempt = { version: ROOM_AUDIO_ANALYSIS_VERSION, attemptId: input.attemptId,
            sourceRevision: source.sourceRevision, objectKey: source.objectKey, leaseToken,
            leaseExpiresAt: new Date(dependencies.now() + leaseMs), state: 'running', reason: null,
            updatedAt: new Date(dependencies.now()) };
        const owned = { ...sourceFilter(track, source), 'roomAudioAnalysis.leaseToken': leaseToken,
            'roomAudioAnalysis.state': 'running', 'roomAudioAnalysis.leaseExpiresAt': { $gt: new Date(dependencies.now()) } };
        let directory: string | undefined;
        let claimed = false;
        let claimDispatched = false;
        let body: { destroy?: () => void } | undefined;
        const reconcile = async (): Promise<RoomAudioAnalysisOutcome> => {
            try {
                const current = await read(input.mediaTrackId);
                const state = recordedAttempt(current);
                const currentSource = sourceFor(current);
                if (!currentSource) return outcome('stale', 'source_changed');
                if (state?.attemptId === input.attemptId && state.leaseToken === leaseToken && terminal.has(state.state)) {
                    if (state.resultRevision ? (currentSource.representation?.revision !== state.resultRevision
                        || currentSource.objectKey !== source.objectKey) : currentSource.sourceRevision !== source.sourceRevision) return outcome('stale', 'source_changed');
                    return outcome(state.state as Exclude<AnalysisAttempt['state'], 'running'>, state.reason);
                }
                if (!current || sourceFor(current)?.sourceRevision !== source.sourceRevision) return outcome('stale', 'source_changed');
            } catch { /* Uncertain writes retain their original attempt for explicit state recovery. */ }
            return outcome('unknown');
        };
        const finish = async (state: Exclude<AnalysisAttempt['state'], 'running'>, reason: RoomAudioAnalysisReason | null,
            representation?: MediaRepresentation): Promise<RoomAudioAnalysisOutcome> => {
            try {
                const result = await tracks().updateOne({ ...owned,
                    'roomAudioAnalysis.leaseExpiresAt': { $gt: new Date(dependencies.now()) } }, { $set: {
                    roomAudioAnalysis: { ...record, state, reason, updatedAt: new Date(dependencies.now()),
                        ...(representation ? { resultRevision: representation.revision } : {}) },
                    ...(representation ? { mediaRepresentation: representation } : {})
                } }, { maxTimeMS: 5_000 });
                return result.matchedCount === 1 ? outcome(state, reason) : outcome('stale', 'source_changed');
            } catch { return reconcile(); }
        };
        const checkAbort = () => { if (controller.signal.aborted) throw new DOMException('Analysis canceled.', 'AbortError'); };
        try {
            checkAbort();
            claimDispatched = true;
            const reservation = await tracks().updateOne({ ...sourceFilter(track, source),
                roomAudioAnalysis: track.roomAudioAnalysis ?? null }, { $set: { roomAudioAnalysis: record } }, { maxTimeMS: 5_000 });
            if (reservation.matchedCount !== 1) return outcome('busy');
            claimed = true;
            checkAbort();
            const params = { Bucket: process.env.S3_BUCKET_NAME!, Key: source.objectKey,
                ...(source.representation ? { IfMatch: source.representation.etag!,
                    ...(source.representation.versionId ? { VersionId: source.representation.versionId } : {}) } : {}) };
            const metadata = await dependencies.storage().send(new HeadObjectCommand(params), { abortSignal: controller.signal });
            const size = metadata.ContentLength;
            const etag = metadata.ETag;
            const versionId = metadata.VersionId ?? null;
            if (!Number.isSafeInteger(size) || typeof etag !== 'string'
                || !/^"[^"\r\n]{1,200}"$/.test(etag) || versionId !== null
                    && (typeof versionId !== 'string' || !versionId || versionId.length > 1024 || /[\r\n]/.test(versionId)))
                return finish('failed', 'storage_unavailable');
            if (size! <= 0 || size! > maximumBytes) return finish('unsupported', 'unsupported_audio');
            if (source.representation && (size !== source.representation.byteLength || etag !== source.representation.etag
                || source.representation.versionId && versionId !== source.representation.versionId)) return finish('stale', 'source_changed');
            const pinned = { ...params, IfMatch: etag, ...(versionId ? { VersionId: versionId } : {}) };
            const object = await dependencies.storage().send(new GetObjectCommand(pinned), { abortSignal: controller.signal });
            if (object.ETag !== etag || object.ContentLength !== size || (object.VersionId ?? null) !== versionId || !object.Body) {
                (object.Body as any)?.destroy?.(); return finish('stale', 'source_changed');
            }
            body = object.Body as typeof body;
            directory = await mkdtemp(join(tmpdir(), 'archtree-room-audio-'));
            const filePath = join(directory, 'source');
            let received = 0;
            const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;
                if (received > size!) callback(new Error('Analysis source length mismatch.')); else callback(null, chunk);
            } });
            await pipeline(object.Body as any, bound, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
            if (received !== size) return finish('stale', 'source_changed');
            const inspected = await dependencies.inspect({ path: filePath, size, buffer: undefined } as unknown as Express.Multer.File,
                { signal: controller.signal });
            checkAbort();
            // Legacy sources had no pinned version. Recheck the current key before adopting the bytes read above.
            const confirmed = await dependencies.storage().send(new HeadObjectCommand({ ...params, IfMatch: etag }),
                { abortSignal: controller.signal });
            if (confirmed.ETag !== etag || confirmed.ContentLength !== size || (confirmed.VersionId ?? null) !== versionId)
                return finish('stale', 'source_changed');
            await assertAdmin(input.actorId); checkAbort();
            const representation: MediaRepresentation = { revision: `mr_${randomBytes(16).toString('hex')}`,
                objectKey: source.objectKey, byteLength: size!, durationMs: inspected?.durationMs ?? null,
                seekable: inspected !== null, format: inspected?.format ?? 'unsupported', etag, versionId,
                analysisVersion: ROOM_AUDIO_ANALYSIS_VERSION };
            return finish(inspected ? 'complete' : 'unsupported', inspected ? null : 'unsupported_audio', representation);
        } catch (error) {
            if (!claimed) return controller.signal.aborted && !claimDispatched
                ? outcome(input.signal?.aborted ? 'cancelled' : 'failed', input.signal?.aborted ? 'cancelled' : 'analysis_timeout')
                : reconcile();
            const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
            const code: RoomAudioAnalysisReason = controller.signal.aborted
                ? input.signal?.aborted ? 'cancelled' : 'analysis_timeout'
                : status === 404 || status === 412 ? 'source_changed'
                    : error instanceof RoomAudioInspectionError ? error.code
                    : error instanceof RoomAudioAnalysisError ? 'analysis_failed' : 'storage_unavailable';
            return finish(code === 'cancelled' ? 'cancelled' : code === 'source_changed' ? 'stale' : 'failed', code);
        } finally {
            clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); body?.destroy?.();
            if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
            active = false;
        }
    };
    return { list, analyze };
};

const service = createRoomAudioAnalysisService();
export const listRoomAudioAnalysis = service.list;
export const analyzeRoomAudioTrack = service.analyze;
