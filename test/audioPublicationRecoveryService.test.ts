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
