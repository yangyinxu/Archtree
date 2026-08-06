import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadAudioTrackFile } from '../src/controllers/audioTrackController';
import { uploadAudioTrackWeb } from '../src/controllers/contentController';

const audioTrackId = '507f1f77bcf86cd799439011';
const uploadFile = {
    fieldname: 'audioFile',
    originalname: 'track.mp3',
    encoding: '7bit',
    mimetype: 'audio/mpeg',
    size: 3,
    buffer: Buffer.from('mp3')
} as Express.Multer.File;

const invalidPublicationStates = [
    { stored: null, label: 'null' },
    { stored: '', label: '' },
    { stored: 'unexpected', label: 'unexpected' }
] as const;

const failedPublicationReport = (publicationStatus: string) => ({
    requestedCount: 1,
    readyCount: 0,
    failedCount: 1,
    results: [{
        audioTrackId,
        albumId: '',
        uploadStatus: 'ready',
        uploadReady: true,
        publicationStatusBefore: publicationStatus,
        publicationStatus,
        outcome: 'failed' as const,
        error: 'The explicit publication state is not publishable.'
    }]
});

test('single-file API upload retries and truthfully reports explicit invalid publication states', async () => {
    for (const state of invalidPublicationStates) {
        let retryCalls = 0;
        const captured: { statusCode?: number; body?: any } = {};
        const response = {
            status(statusCode: number) {
                captured.statusCode = statusCode;
                return response;
            },
            json(body: unknown) {
                captured.body = body;
                return response;
            }
        } as any;

        await uploadAudioTrackFile({
            auth: { userId: 'admin-id', role: 'admin' },
            params: { audioTrackId },
            file: uploadFile
        } as any, response, (() => undefined) as any, {
            findTrack: async () => ({
                createdBy: 'admin-id',
                publicationStatus: state.stored
            }),
            uploadObject: async () => ({ cleanupPending: false, s3Key: audioTrackId }),
            retryPublications: async (ids) => {
                retryCalls += 1;
                assert.deepEqual(ids, [audioTrackId]);
                return failedPublicationReport(state.label);
            }
        });

        assert.equal(retryCalls, 1);
        assert.equal(captured.statusCode, 409);
        assert.equal(captured.body?.uploadStatus, 'ready');
        assert.equal(captured.body?.publicationStatus, state.label);
        assert.equal(captured.body?.publicationOutcome, 'failed');
        assert.equal(captured.body?.publicationRetryRequired, true);
        assert.match(captured.body?.message ?? '', /without uploading the file again/i);
    }
});

test('single-file Content Manager upload retries and exposes explicit invalid publication states', async () => {
    for (const state of invalidPublicationStates) {
        let retryCalls = 0;
        let redirectedTo = '';
        let nextError: unknown;
        const response = {
            redirect(location: string) {
                redirectedTo = location;
                return response;
            }
        } as any;

        await uploadAudioTrackWeb({
            auth: { userId: 'admin-id', role: 'admin' },
            body: { audioTrackId },
            file: uploadFile
        } as any, response, ((error?: unknown) => { nextError = error; }) as any, {
            findTrack: async () => ({
                createdBy: 'admin-id',
                publicationStatus: state.stored
            }),
            uploadObject: async () => ({ cleanupPending: false, s3Key: audioTrackId }),
            retryPublications: async (ids) => {
                retryCalls += 1;
                assert.deepEqual(ids, [audioTrackId]);
                return failedPublicationReport(state.label);
            }
        });

        assert.equal(nextError, undefined);
        assert.equal(retryCalls, 1);
        const message = decodeURIComponent(redirectedTo);
        assert.match(message, /Audio file uploaded, but publication status is/i);
        assert.match(message, new RegExp(state.label === '' ? 'empty' : state.label));
        assert.match(message, /without uploading the file again/i);
    }
});
