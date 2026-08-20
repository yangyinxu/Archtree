import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isVideoObjectKeyForTrack,
    readyVideoObjectKey,
    videoObjectKeysForTrack
} from '../src/utils/videoStorageKey';

const trackId = '507f1f77bcf86cd799439011';
const assetId = '507f1f77bcf86cd799439012';
const key = `video/${trackId}/${assetId}`;

test('video keys are versioned and bound to the owning Soundtrack identity', () => {
    assert.equal(isVideoObjectKeyForTrack(key, trackId), true);
    assert.equal(isVideoObjectKeyForTrack(key.toUpperCase(), trackId), true);
    assert.equal(isVideoObjectKeyForTrack(`video/${assetId}/${trackId}`, trackId), false);
    assert.equal(isVideoObjectKeyForTrack(`audio/${trackId}/${assetId}`, trackId), false);
    assert.equal(isVideoObjectKeyForTrack('video/catalog/demo', trackId), false);
});

test('public video readiness requires a complete ready MP4 asset', () => {
    const track = {
        _id: trackId,
        videoAsset: {
            active: {
                status: 'ready',
                s3Key: key,
                contentType: 'video/mp4',
                byteLength: 1024
            }
        }
    };
    assert.equal(readyVideoObjectKey(track), key);
    assert.equal(readyVideoObjectKey({
        ...track,
        videoAsset: { active: { ...track.videoAsset.active, status: 'deleting' } }
    }), null);
    assert.equal(readyVideoObjectKey({
        ...track,
        videoAsset: { active: { ...track.videoAsset.active, byteLength: 0 } }
    }), null);
});

test('cleanup enumerates every unique exact lifecycle key and rejects foreign keys', () => {
    const secondKey = `video/${trackId}/507f1f77bcf86cd799439013`;
    assert.deepEqual(videoObjectKeysForTrack({
        active: { s3Key: key } as any,
        pending: { s3Key: secondKey } as any,
        cleanup: { s3Key: key } as any,
        revision: 3
    }, trackId), [key, secondKey]);
    assert.throws(() => videoObjectKeysForTrack({
        active: null,
        pending: { s3Key: `video/${assetId}/${trackId}` } as any,
        cleanup: null,
        revision: 1
    }, trackId), /missing or invalid/);
});
