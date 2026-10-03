import assert from 'node:assert/strict';
import test from 'node:test';

import { retryAudioTrackPublications } from '../src/services/audioPublicationRecoveryService';

test('a shared publication source read failure still returns one isolated outcome per request item', async () => {
    const firstId = '507f1f77bcf86cd799439011';
    const secondId = '507f1f77bcf86cd799439012';
    const report = await retryAudioTrackPublications([
        firstId,
        firstId.toUpperCase(),
        'not-an-object-id',
        secondId
    ], {
        findRecords: async () => {
            throw new Error('database timeout');
        }
    });

    assert.equal(report.requestedCount, 4);
    assert.equal(report.readyCount, 0);
    assert.equal(report.failedCount, 4);
    assert.deepEqual(report.results.map((result) => ({
        audioTrackId: result.audioTrackId,
        uploadStatus: result.uploadStatus,
        publicationStatus: result.publicationStatus,
        outcome: result.outcome
    })), [
        {
            audioTrackId: firstId,
            uploadStatus: 'unknown',
            publicationStatus: 'unknown',
            outcome: 'unknown'
        },
        {
            audioTrackId: firstId,
            uploadStatus: 'duplicate',
            publicationStatus: 'duplicate',
            outcome: 'duplicate'
        },
        {
            audioTrackId: 'not-an-object-id',
            uploadStatus: 'invalid',
            publicationStatus: 'invalid',
            outcome: 'invalid'
        },
        {
            audioTrackId: secondId,
            uploadStatus: 'unknown',
            publicationStatus: 'unknown',
            outcome: 'unknown'
        }
    ]);
    assert.match(report.results[0].error ?? '', /database timeout/);
});

const notReadyMessage = 'The existing uploaded object is not database-confirmed ready.';

test('publication retry rejects a storage key outside the recorded media kind namespace', async () => {
    const audioRowWithVideoKeyId = '507f1f77bcf86cd799439021';
    const legacyRowWithVideoKeyId = '507f1f77bcf86cd799439022';
    const videoRowWithAudioKeyId = '507f1f77bcf86cd799439023';
    const videoRowWithLegacyKeyId = '507f1f77bcf86cd799439024';
    const albumId = '507f1f77bcf86cd799439031';
    const objectId = '507f1f77bcf86cd799439041';
    const confirmations: string[] = [];
    const report = await retryAudioTrackPublications([
        audioRowWithVideoKeyId,
        legacyRowWithVideoKeyId,
        videoRowWithAudioKeyId,
        videoRowWithLegacyKeyId
    ], {
        findRecords: async () => [
            {
                _id: audioRowWithVideoKeyId,
                albumId,
                mediaType: 'audio',
                s3Key: `video/${audioRowWithVideoKeyId}/${objectId}`,
                uploadStatus: 'ready',
                publicationStatus: 'pending'
            },
            {
                _id: legacyRowWithVideoKeyId,
                albumId,
                s3Key: `video/${legacyRowWithVideoKeyId}/${objectId}`,
                uploadStatus: 'ready',
                publicationStatus: 'failed'
            },
            {
                _id: videoRowWithAudioKeyId,
                albumId,
                mediaType: 'video',
                s3Key: `audio/${videoRowWithAudioKeyId}/${objectId}`,
                uploadStatus: 'ready',
                publicationStatus: 'pending'
            },
            {
                _id: videoRowWithLegacyKeyId,
                albumId,
                mediaType: 'video',
                s3Key: videoRowWithLegacyKeyId,
                uploadStatus: 'ready',
                publicationStatus: 'failed'
            }
        ],
        findRecord: async () => null,
        confirmPublication: async (audioTrackId) => {
            confirmations.push(audioTrackId);
            return false;
        }
    });

    assert.equal(report.readyCount, 0);
    assert.deepEqual(report.results.map((result) => ({
        audioTrackId: result.audioTrackId,
        uploadReady: result.uploadReady,
        outcome: result.outcome,
        error: result.error
    })), [
        audioRowWithVideoKeyId,
        legacyRowWithVideoKeyId,
        videoRowWithAudioKeyId,
        videoRowWithLegacyKeyId
    ].map((audioTrackId) => ({
        audioTrackId,
        uploadReady: false,
        outcome: 'failed',
        error: notReadyMessage
    })));
    assert.deepEqual(confirmations, [], 'a wrong-kind key must never reach publication');
});

test('publication retry treats an identity-bound ready Video object as upload-ready', async () => {
    const videoTrackId = '507f1f77bcf86cd799439051';
    const audioTrackId = '507f1f77bcf86cd799439052';
    const albumId = '507f1f77bcf86cd799439061';
    const objectId = '507f1f77bcf86cd799439071';
    const confirmations: Array<[string, string]> = [];
    const report = await retryAudioTrackPublications([videoTrackId, audioTrackId], {
        findRecords: async () => [
            {
                _id: videoTrackId,
                albumId,
                mediaType: 'video',
                s3Key: `video/${videoTrackId}/${objectId}`,
                uploadStatus: 'ready',
                publicationStatus: 'pending'
            },
            {
                _id: audioTrackId,
                albumId,
                mediaType: 'audio',
                s3Key: `audio/${audioTrackId}/${objectId}`,
                uploadStatus: 'ready',
                publicationStatus: 'failed'
            }
        ],
        findRecord: async () => ({ publicationStatus: 'pending', publicationError: null }),
        confirmPublication: async (trackId, album) => {
            confirmations.push([trackId, album]);
            return false;
        }
    });

    assert.deepEqual(
        report.results.map((result) => [result.audioTrackId, result.uploadReady]),
        [[videoTrackId, true], [audioTrackId, true]]
    );
    assert.ok(report.results.every((result) => result.error !== notReadyMessage));
    assert.deepEqual(
        [...new Set(confirmations.map(([trackId, album]) => `${trackId}:${album}`))],
        [`${videoTrackId}:${albumId}`, `${audioTrackId}:${albumId}`],
        'both media kinds enter the idempotent publication path'
    );
});
