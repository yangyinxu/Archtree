import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
    downloadAudioTrack,
    deleteAudioTrack,
    headAudioTrackDownload,
    headAudioTrackStream,
    postAudioTrack,
    streamAudioTrack,
    uploadAudioTrackFile
} from '../src/controllers/audioTrackController';
import { headMediaTrack, streamMediaTrack } from '../src/controllers/mediaTrackController';
import { headSoundtrackVideo, streamSoundtrackVideo } from '../src/controllers/soundtrackVideoController';
import { Artist } from '../src/models/artist';
import { AudioTrack } from '../src/models/audioTrack';
import {
    AudioStorageLifecycleError,
    deleteAudioObjectAndTrack,
    uploadMediaObject,
    type AudioTrackDeletionDependencies
} from '../src/services/audioStorageService';

const trackId = '507f1f77bcf86cd799439011';
const artistId = '507f1f77bcf86cd799439013';
const replacementKey = `video/${trackId}/507f1f77bcf86cd799439012`;
const privateMarker = 'private-recording-with-credential';
const requestId = 'server-generated-request-id';

/** Captures every old and new log sink so a raw-exception fallback cannot escape assertions. */
const captureLogs = (context: TestContext) => {
    const messages: unknown[][] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
        context.mock.method(console, method, (...args: unknown[]) => { messages.push(args); });
    }
    return messages;
};

const sensitiveFailure = (extra: Record<string, unknown> = {}) => Object.assign(
    new Error(`${privateMarker}: ${trackId}; ${replacementKey}`),
    { details: { filename: `${privateMarker}.mp3`, authorization: privateMarker }, ...extra }
);

/** Requires the complete log shape, including the absence of private exception properties. */
const assertDiagnostics = (messages: unknown[][], expected: Record<string, unknown>[]) => {
    assert.deepEqual(messages.map(args => {
        assert.equal(args.length, 1);
        assert.equal(typeof args[0], 'string');
        return JSON.parse(args[0] as string);
    }), expected);
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(`${privateMarker}|${trackId}|${replacementKey}`));
};

/** Supplies only HTTP state needed by abort-aware failure handlers, without opening a listener. */
const httpCapture = () => {
    const req = Object.assign(new EventEmitter(), {
        params: { audioTrackId: trackId, mediaTrackId: trackId }, headers: {}, query: {}, body: {}
    }) as any;
    const res = Object.assign(new EventEmitter(), {
        locals: { requestId }, statusCode: 200, writableEnded: false, headersSent: false,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; this.writableEnded = true; return this; },
        end() { this.writableEnded = true; return this; }
    }) as any;
    return { req, res };
};

const unexpectedNext = (error?: unknown) => { throw error ?? new Error('Unexpected middleware delegation.'); };

test('legacy and canonical Audio/Video/download failures log bounded categories and retain HTTP outcomes', async context => {
    const messages = captureLogs(context);
    context.mock.method(AudioTrack, 'findReadyPublicById', async () => {
        throw sensitiveFailure({ name: 'MongoServerError' });
    });
    const handlers = [
        [headAudioTrackStream, 'media_probe_failed'],
        [streamAudioTrack, 'media_stream_failed'],
        [headAudioTrackDownload, 'media_probe_failed'],
        [downloadAudioTrack, 'media_download_failed'],
        [headSoundtrackVideo, 'media_probe_failed'],
        [streamSoundtrackVideo, 'media_stream_failed'],
        [headMediaTrack, 'media_probe_failed'],
        [streamMediaTrack, 'media_stream_failed']
    ] as const;
    for (const [handler] of handlers) {
        const { req, res } = httpCapture();
        await handler(req, res, unexpectedNext);
        assert.equal(res.statusCode, 502);
        assert.equal(req.listenerCount('aborted'), 0);
        assert.equal(res.listenerCount('close'), 0);
    }
    assertDiagnostics(messages, handlers.map(([, category]) => ({
        category, requestId, errorCategory: 'database'
    })));
});

test('media cancellation remains silent and missing content remains unlogged', async context => {
    const messages = captureLogs(context);
    context.mock.method(AudioTrack, 'findReadyPublicById', async () => {
        throw sensitiveFailure({ name: 'AbortError' });
    });
    for (const handler of [headAudioTrackStream, streamAudioTrack, headAudioTrackDownload,
        downloadAudioTrack, headSoundtrackVideo, streamSoundtrackVideo, headMediaTrack, streamMediaTrack]) {
        const { req, res } = httpCapture();
        await handler(req, res, unexpectedNext);
        assert.equal(res.writableEnded, false);
    }
    context.mock.restoreAll();
    const missingMessages = captureLogs(context);
    context.mock.method(AudioTrack, 'findReadyPublicById', async () => null);
    const { req, res } = httpCapture();
    await streamAudioTrack(req, res, unexpectedNext);
    assert.equal(res.statusCode, 404);
    assertDiagnostics(messages, []);
    assertDiagnostics(missingMessages, []);
});

test('legacy creation excludes uploaded filename, metadata path and database exception from diagnostics', async context => {
    const messages = captureLogs(context);
    context.mock.method(Artist, 'findById', async () => ({ _id: artistId }) as any);
    context.mock.method(AudioTrack.prototype, 'save', async () => {
        throw sensitiveFailure({ name: 'MongoServerError' });
    });
    const { req, res } = httpCapture();
    req.auth = { userId: 'admin-id', role: 'admin' };
    req.body = { title: privateMarker, artistIds: [artistId], genres: [], albumId: '', duration: '' };
    req.file = {
        fieldname: 'audioFile', originalname: `${privateMarker}.mp3`, mimetype: 'audio/mpeg',
        path: path.join(tmpdir(), `${privateMarker}-${randomUUID()}.mp3`), size: 3
    };
    await postAudioTrack(req, res, unexpectedNext);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.outcomeUnknown, false);
    assertDiagnostics(messages, [
        { category: 'audio_metadata_unavailable', requestId, errorCategory: 'internal' },
        { category: 'media_upload_failed', requestId, errorCategory: 'database' }
    ]);
});

test('legacy upload preserves unknown-outcome recovery while suppressing sensitive exception data', async context => {
    const messages = captureLogs(context);
    const { req, res } = httpCapture();
    req.auth = { userId: 'admin-id', role: 'admin' };
    req.file = { originalname: `${privateMarker}.mp3` };
    await uploadAudioTrackFile(req, res, unexpectedNext, {
        findTrack: async () => ({ createdBy: 'admin-id' }),
        uploadObject: async () => { throw sensitiveFailure({ code: 'ETIMEDOUT', outcomeUnknown: true, cleanupPending: true }); },
        retryPublications: async () => { throw new Error('A failed upload must not retry publication.'); }
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.cleanupPending, true);
    assert.match(res.body.message, /Reconciliation is required/);
    assertDiagnostics(messages, [{ category: 'media_upload_failed', requestId, errorCategory: 'timeout' }]);
});

test('legacy deletion lookup and lifecycle conflicts keep their existing outcomes without exposing IDs in logs', async context => {
    const messages = captureLogs(context);
    let hasPendingUpload = false;
    context.mock.method(AudioTrack, 'findById', async () => {
        if (!hasPendingUpload) throw sensitiveFailure({ name: 'MongoServerError' });
        return { pendingUploadStatus: 'pending', pendingS3Key: replacementKey } as any;
    });
    const lookup = httpCapture();
    lookup.req.auth = { userId: 'admin-id', role: 'admin' };
    await deleteAudioTrack(lookup.req, lookup.res, unexpectedNext);
    assert.equal(lookup.res.statusCode, 500);

    hasPendingUpload = true;
    const conflict = httpCapture();
    conflict.req.auth = { userId: 'admin-id', role: 'admin' };
    await deleteAudioTrack(conflict.req, conflict.res, unexpectedNext);
    assert.equal(conflict.res.statusCode, 409);
    assert.equal(conflict.res.body.cleanupPending, true);
    assertDiagnostics(messages, [
        { category: 'media_deletion_failed', requestId, errorCategory: 'database' },
        { category: 'media_deletion_failed', requestId, errorCategory: 'internal' }
    ]);
});

/** Isolates deletion boundaries so only the intended recovery-state write can fail. */
const deletionDependencies = (sourceError: Error, stateError: Error, referencesFail: boolean): AudioTrackDeletionDependencies => ({
    findTrack: async () => ({ s3Key: trackId, uploadStatus: 'ready' }),
    beginDeletion: async () => ({ matchedCount: 1 }),
    updateTrackWhere: async (_id, _expected, update) => {
        if (update.uploadStatus === 'deleteFailed') throw stateError;
        return { matchedCount: 1 };
    },
    deleteAudioObject: async () => { if (!referencesFail) throw sourceError; },
    prepareTrackCoverArtDeletion: async () => false,
    finalizeTrackCoverArtDeletion: async () => { throw new Error('Must not finalize failed deletion.'); },
    cleanupReferences: async () => { if (referencesFail) throw sourceError; },
    deleteTrack: async () => { throw new Error('Must not erase failed-deletion evidence.'); }
});

test('deletion and reference-recovery write failures log categories without IDs or raw errors', async context => {
    const messages = captureLogs(context);
    const sourceError = sensitiveFailure({ code: 'ETIMEDOUT' });
    const stateError = sensitiveFailure({ name: 'MongoServerError' });
    for (const referencesFail of [false, true]) {
        await assert.rejects(deleteAudioObjectAndTrack(
            trackId, deletionDependencies(sourceError, stateError, referencesFail)
        ), error => error === sourceError);
    }
    assertDiagnostics(messages, [
        { category: 'media_deletion_state_write_failed', errorCategory: 'database' },
        { category: 'media_reference_cleanup_state_write_failed', errorCategory: 'database' }
    ]);
});

test('upload recovery-state write failure preserves pending evidence and reports only its fixed category', async context => {
    const messages = captureLogs(context);
    const sourceError = sensitiveFailure({ $metadata: { httpStatusCode: 403 } });
    const stateError = sensitiveFailure({ name: 'MongoServerError' });
    let state: any = { s3Key: trackId, mediaType: 'audio', uploadStatus: 'ready' };
    await assert.rejects(uploadMediaObject(trackId, {
        originalname: `${privateMarker}.mp4`, size: 5, buffer: Buffer.from('video'), mimetype: 'video/mp4'
    } as Express.Multer.File, 'owner-id', 'video', undefined, {
        findTrack: async () => ({ ...state }),
        createObjectKey: () => replacementKey,
        updateTrackWhere: async (_id, _expected, update) => {
            if (update.pendingUploadStatus === 'failed') throw stateError;
            state = { ...state, ...update };
            return { matchedCount: 1 };
        },
        putObject: async () => { throw sourceError; },
        deleteObject: async () => { throw new Error('A definitely rejected PUT needs no storage deletion.'); }
    }), error => error instanceof AudioStorageLifecycleError && error.cause === sourceError
        && error.cleanupPending && !error.outcomeUnknown);
    assert.equal(state.s3Key, trackId);
    assert.equal(state.pendingS3Key, replacementKey);
    assert.equal(state.pendingUploadStatus, 'pending');
    assertDiagnostics(messages, [{ category: 'media_upload_state_write_failed', errorCategory: 'database' }]);
});
