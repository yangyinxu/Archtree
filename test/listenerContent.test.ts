import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeListenerLibraryPage } from '../src/services/listenerContentService';

const forbiddenKeys = new Set(['createdBy', 's3Key', 'uploadStatus', 'uploadError']);

const collectKeys = (value: unknown, keys = new Set<string>()) => {
    if (!value || typeof value !== 'object') return keys;
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, keys);
        return keys;
    }
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        collectKeys(nested, keys);
    }
    return keys;
};

test('listener Library projection strips ownership and audio lifecycle fields', () => {
    const readyId = '64b000000000000000000001';
    const pendingId = '64b000000000000000000002';
    const page = sanitizeListenerLibraryPage({
        items: [
            {
                contentType: 'album',
                contentId: '64b000000000000000000003',
                savedAt: new Date('2026-08-01T00:00:00Z'),
                creator: 'Listener Artist',
                album: {
                    _id: '64b000000000000000000003',
                    title: 'Safe Album',
                    coverArtUrl: '/cover.jpg',
                    releaseDate: { year: 2026 },
                    createdBy: 'owner-secret'
                }
            },
            {
                contentType: 'audioTrack',
                contentId: readyId,
                savedAt: new Date('2026-08-02T00:00:00Z'),
                audioTrack: {
                    _id: readyId,
                    title: 'Ready Track',
                    albumId: null,
                    displayCoverArtUrl: '/display.jpg',
                    coverArtUrl: '/track.jpg',
                    uploadStatus: 'ready',
                    s3Key: 'private/storage/key',
                    uploadError: null,
                    createdBy: 'owner-secret'
                }
            },
            {
                contentType: 'audioTrack',
                contentId: pendingId,
                savedAt: new Date('2026-08-03T00:00:00Z'),
                audioTrack: {
                    _id: pendingId,
                    title: 'Pending Track',
                    uploadStatus: 'pending',
                    s3Key: 'orphaned-key'
                }
            }
        ],
        nextCursor: 'next-page'
    });

    assert.deepEqual(page.items.map((item) => item.contentType), ['album', 'audioTrack', 'audioTrack']);
    assert.deepEqual(
        page.items
            .filter((item) => item.contentType === 'audioTrack')
            .map((item: any) => [item.audioTrack.available, item.audioTrack.streamUrl]),
        [
            [true, `/content/audioTrack/stream/${readyId}`],
            [false, null]
        ]
    );
    assert.equal(page.nextCursor, 'next-page');
    const keys = collectKeys(page);
    for (const forbidden of forbiddenKeys) assert.equal(keys.has(forbidden), false);
});
