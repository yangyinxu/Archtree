import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAudioStorageAuditPage } from '../src/views/admin/audioStorageAuditView';

const report = {
    generatedAt: new Date('2026-08-17T12:00:00Z'),
    bucket: 'audio-bucket',
    summary: {},
    orphanedObjects: [{
        key: 'audio/track/orphan',
        originalFileName: '<orphan>.flac',
        size: 42
    }],
    missingObjects: [{
        audioTrackId: '667f4e0ace50714e897961bf',
        s3Key: 'audio/667f4e0ace50714e897961bf/6a66626781d495b9ec430e6c',
        title: '<missing>',
        uploadStatus: 'legacy',
        publicationStatus: 'legacy'
    }],
    incompleteTracks: [{
        audioTrackId: 'retry-track',
        title: 'Retry me',
        uploadStatus: 'ready',
        publicationStatus: 'failed',
        objectExists: true
    }]
};

test('audit maps each discrepancy to a state-valid recommended action', () => {
    const html = renderAudioStorageAuditPage(report, 'admin@example.com');

    assert.match(html, /Recommended workflow/);
    assert.match(html, /action="\/admin\/audio-storage\/orphan-delete"/);
    assert.match(html, /Delete orphaned S3 object/);
    assert.match(html, /Open Soundtrack workspace/);
    assert.match(html, /action="\/admin\/audio-storage\/missing-track-delete"/);
    assert.match(html, /Delete MongoDB record/);
    assert.match(html, /action="\/admin\/audio-storage\/publication-retry"/);
    assert.match(html, /Retry publication/);
    assert.equal((html.match(/Delete orphaned S3 object/g) ?? []).length, 1);
    assert.equal((html.match(/Delete MongoDB record/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<orphan>|<missing>/);
    assert.match(html, /&lt;orphan&gt;\.flac/);
});

test('missing and non-ready Soundtracks never receive an S3 delete or publication retry action', () => {
    const html = renderAudioStorageAuditPage({
        ...report,
        orphanedObjects: [],
        incompleteTracks: [{
            audioTrackId: 'pending-track',
            title: 'Pending',
            uploadStatus: 'pending',
            publicationStatus: 'pending',
            objectExists: false
        }]
    }, 'admin@example.com');

    assert.doesNotMatch(html, /orphan-delete/);
    assert.doesNotMatch(html, /Retry publication/);
    assert.match(html, /upload a replacement or remove the record safely/);
});

test('MongoDB-only rows with invalid storage identity do not receive direct deletion', () => {
    const html = renderAudioStorageAuditPage({
        ...report,
        orphanedObjects: [],
        missingObjects: [{
            audioTrackId: '667f4e0ace50714e897961bf',
            s3Key: 'audio/another-track/object',
            title: 'Unsafe identity'
        }],
        incompleteTracks: []
    }, 'admin@example.com');

    assert.doesNotMatch(html, /missing-track-delete/);
    assert.match(html, /Stored S3 identity is invalid/);
});

test('audit status messages are escaped and can communicate a failed remediation', () => {
    const html = renderAudioStorageAuditPage(report, 'admin@example.com', '<failed>', true);
    assert.match(html, /alert--error/);
    assert.match(html, /&lt;failed&gt;/);
    assert.doesNotMatch(html, /<failed>/);
});
