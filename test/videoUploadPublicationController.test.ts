import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadSoundtrackVideoFile } from '../src/controllers/soundtrackVideoController';
import { uploadSoundtrackVideoWeb } from '../src/controllers/contentController';
import { AudioStorageLifecycleError } from '../src/services/audioStorageService';
import {
    retryPublicationAfterUpload,
    type AudioPublicationRetryResult
} from '../src/services/audioPublicationRecoveryService';
import { InvalidSoundtrackVideoError } from '../src/services/videoMetadataService';

const audioTrackId = '507f1f77bcf86cd799439011';
const videoKey = `video/${audioTrackId}/507f1f77bcf86cd799439012`;
const uploadFile = {
    fieldname: 'videoFile',
    originalname: 'lorem-ipsum.mp4',
    encoding: '7bit',
    mimetype: 'video/mp4',
    size: 3,
    buffer: Buffer.from('mp4')
} as Express.Multer.File;

const publicationReport = (
    outcome: AudioPublicationRetryResult['outcome'],
    publicationStatus: string
) => ({
    requestedCount: 1,
    readyCount: outcome === 'ready' ? 1 : 0,
    failedCount: outcome === 'ready' ? 0 : 1,
    results: [{
        audioTrackId,
        albumId: '',
        uploadStatus: 'ready',
        uploadReady: true,
        publicationStatusBefore: 'failed',
        publicationStatus,
        outcome,
        error: outcome === 'ready' ? null : 'One or more Albums are unavailable for new references.'
    }]
});

/** Records the order of replacement and publication work for one handler call. */
const fakeDependencies = (
    report: ReturnType<typeof publicationReport>,
    options: { cleanupPending?: boolean; uploadError?: unknown; validationError?: unknown } = {}
) => {
    const calls: string[] = [];
    return {
        calls,
        dependencies: {
            findTrack: async () => ({ _id: audioTrackId, createdBy: 'lorem-admin' }),
            validateVideo: async () => {
                calls.push('validate');
                if (options.validationError) throw options.validationError;
                return { contentType: 'video/mp4' as const, durationSeconds: 1 };
            },
            uploadObject: async (id: string) => {
                calls.push(`upload:${id}`);
                if (options.uploadError) throw options.uploadError;
                return {
                    cleanupPending: options.cleanupPending ?? false,
                    s3Key: videoKey,
                    mediaType: 'video' as const
                };
            },
            retryPublications: async (ids: readonly string[]) => {
                calls.push(`retry:${ids.join(',')}`);
                return report;
            }
        }
    };
};

const jsonResponse = () => {
    const captured: { statusCode?: number; body?: any } = {};
    const response = {
        locals: {},
        status(statusCode: number) {
            captured.statusCode = statusCode;
            return response;
        },
        json(body: unknown) {
            captured.body = body;
            return response;
        }
    } as any;
    return { captured, response };
};

const apiRequest = () => ({
    auth: { userId: 'lorem-admin', role: 'admin' },
    params: { audioTrackId },
    file: uploadFile
}) as any;

test('API Video replacement automatically retries publication after the upload succeeds', async () => {
    const fake = fakeDependencies(publicationReport('ready', 'ready'));
    const { captured, response } = jsonResponse();

    await uploadSoundtrackVideoFile(apiRequest(), response, (() => undefined) as any, fake.dependencies);

    assert.deepEqual(fake.calls, ['validate', `upload:${audioTrackId}`, `retry:${audioTrackId}`]);
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, {
        message: 'MediaTrack was replaced with Video successfully.',
        audioTrackId,
        mediaType: 'video',
        uploadStatus: 'ready',
        publicationStatus: 'ready',
        cleanupPending: false
    });
});

test('API Video replacement reports a failed publication separately from the durable upload', async () => {
    const fake = fakeDependencies(publicationReport('failed', 'failed'), { cleanupPending: true });
    const { captured, response } = jsonResponse();

    await uploadSoundtrackVideoFile(apiRequest(), response, (() => undefined) as any, fake.dependencies);

    assert.equal(captured.statusCode, 409);
    assert.equal(captured.body?.mediaType, 'video');
    assert.equal(captured.body?.uploadStatus, 'ready');
    assert.equal(captured.body?.publicationStatus, 'failed');
    assert.equal(captured.body?.publicationOutcome, 'failed');
    assert.equal(captured.body?.publicationRetryRequired, true);
    assert.equal(captured.body?.reconciliationRequired, false);
    assert.equal(captured.body?.cleanupPending, true);
    assert.match(captured.body?.error ?? '', /Albums are unavailable/);
    assert.match(captured.body?.message ?? '', /Retry publication without uploading the file again/);
});

test('API Video replacement reports an unconfirmed publication as reconciliation-required', async () => {
    const fake = fakeDependencies(publicationReport('unknown', 'unknown'));
    const { captured, response } = jsonResponse();

    await uploadSoundtrackVideoFile(apiRequest(), response, (() => undefined) as any, fake.dependencies);

    assert.equal(captured.statusCode, 503);
    assert.equal(captured.body?.uploadStatus, 'ready');
    assert.equal(captured.body?.publicationOutcome, 'unknown');
    assert.equal(captured.body?.reconciliationRequired, true);
    assert.match(captured.body?.message ?? '', /could not be confirmed\. Reconciliation is required/);
});

test('API Video replacement never retries publication when validation or upload fails', async () => {
    const invalid = fakeDependencies(publicationReport('ready', 'ready'), {
        validationError: new InvalidSoundtrackVideoError('Only MP4 video uploads are supported.')
    });
    const invalidResponse = jsonResponse();
    await uploadSoundtrackVideoFile(
        apiRequest(),
        invalidResponse.response,
        (() => undefined) as any,
        invalid.dependencies
    );
    assert.deepEqual(invalid.calls, ['validate']);
    assert.equal(invalidResponse.captured.statusCode, 400);

    const conflict = fakeDependencies(publicationReport('ready', 'ready'), {
        uploadError: new AudioStorageLifecycleError(
            'MediaTrack cannot be uploaded while deletion is pending.',
            409,
            'audio_storage_mutation_conflict',
            false
        )
    });
    const conflictResponse = jsonResponse();
    await uploadSoundtrackVideoFile(
        apiRequest(),
        conflictResponse.response,
        (() => undefined) as any,
        conflict.dependencies
    );
    assert.deepEqual(conflict.calls, ['validate', `upload:${audioTrackId}`]);
    assert.equal(conflictResponse.captured.statusCode, 409);
    assert.equal(conflictResponse.captured.body?.publicationStatus, undefined);
});

const webRequest = () => ({
    auth: { userId: 'lorem-admin', role: 'admin' },
    body: { audioTrackId },
    file: uploadFile
}) as any;

const redirectResponse = () => {
    const captured: { location?: string } = {};
    const response = {
        redirect(location: string) {
            captured.location = location;
            return response;
        }
    } as any;
    return {
        response,
        message: () => new URL(captured.location ?? '', 'http://127.0.0.1')
            .searchParams.get('message') ?? ''
    };
};

test('Content Manager Video replacement automatically retries and reports each publication outcome', async () => {
    const cases = [
        {
            report: publicationReport('ready', 'ready'),
            cleanupPending: false,
            expected: 'MediaTrack was replaced with Video successfully. Publication status is ready.'
        },
        {
            report: publicationReport('ready', 'ready'),
            cleanupPending: true,
            expected: 'MediaTrack is now Video. Publication status is ready. Previous media cleanup remains recorded for reconciliation.'
        },
        {
            report: publicationReport('failed', 'failed'),
            cleanupPending: false,
            expected: 'MediaTrack is now Video, but publication status is failed. Retry publication without uploading the file again.'
        },
        {
            report: publicationReport('failed', ''),
            cleanupPending: true,
            expected: 'MediaTrack is now Video, but publication status is empty. Retry publication without uploading the file again. Previous media cleanup remains recorded for reconciliation.'
        },
        {
            report: publicationReport('unknown', 'unknown'),
            cleanupPending: false,
            expected: 'MediaTrack is now Video, but publication outcome could not be confirmed. Reconciliation is required.'
        }
    ];
    for (const item of cases) {
        const fake = fakeDependencies(item.report, { cleanupPending: item.cleanupPending });
        const redirect = redirectResponse();
        let nextError: unknown;

        await uploadSoundtrackVideoWeb(
            webRequest(),
            redirect.response,
            ((error?: unknown) => { nextError = error; }) as any,
            fake.dependencies
        );

        assert.equal(nextError, undefined);
        assert.deepEqual(fake.calls, ['validate', `upload:${audioTrackId}`, `retry:${audioTrackId}`]);
        assert.equal(redirect.message(), item.expected);
    }
});

test('Content Manager Video replacement does not retry publication after a failed upload', async () => {
    const fake = fakeDependencies(publicationReport('ready', 'ready'), {
        uploadError: new AudioStorageLifecycleError(
            'S3 rejected the upload.',
            502,
            'audio_storage_upload_failed',
            false
        )
    });
    const redirect = redirectResponse();

    await uploadSoundtrackVideoWeb(webRequest(), redirect.response, (() => undefined) as any, fake.dependencies);

    assert.deepEqual(fake.calls, ['validate', `upload:${audioTrackId}`]);
    assert.equal(
        redirect.message(),
        'Video replacement failed. Lifecycle evidence was retained for retry and reconciliation.'
    );
});

test('post-upload publication reports a thrown or missing recovery result as unknown, not failed', async () => {
    const thrown = await retryPublicationAfterUpload(audioTrackId.toUpperCase(), async () => {
        throw new Error('database timeout');
    });
    assert.equal(thrown.audioTrackId, audioTrackId);
    assert.equal(thrown.uploadStatus, 'ready');
    assert.equal(thrown.outcome, 'unknown');
    assert.equal(thrown.publicationStatus, 'unknown');
    assert.match(thrown.error ?? '', /database timeout/);

    const missing = await retryPublicationAfterUpload(audioTrackId, async () => ({
        requestedCount: 0,
        readyCount: 0,
        failedCount: 0,
        results: []
    }));
    assert.equal(missing.outcome, 'unknown');
    assert.match(missing.error ?? '', /could not be read back/);

    const ready = publicationReport('ready', 'ready');
    assert.deepEqual(
        await retryPublicationAfterUpload(audioTrackId, async () => ready),
        ready.results[0]
    );
});
