import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveMediaTrackByteResponse,
    resolveReadyMediaTrackAsset
} from '../src/controllers/mediaTrackController';

const trackId = '507f1f77bcf86cd799439011';
const videoKey = `video/${trackId}/507f1f77bcf86cd799439012`;
const signal = new AbortController().signal;

const readyTrack = (
    mediaType: 'audio' | 'video',
    overrides: Record<string, unknown> = {}
) => ({
    _id: trackId,
    mediaType,
    uploadStatus: 'ready',
    publicationStatus: 'ready',
    s3Key: mediaType === 'video' ? videoKey : trackId,
    contentType: mediaType === 'video' ? 'video/mp4' : 'audio/mpeg',
    ...overrides
});

test('canonical MediaTrack resolution validates ID, active kind, and exact storage key before S3', async () => {
    let headCalls = 0;
    const headObject = async () => {
        headCalls += 1;
        return { ContentLength: 4096 };
    };

    assert.deepEqual(await resolveReadyMediaTrackAsset('invalid', signal, {
        findReadyTrack: async () => readyTrack('audio'),
        headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyMediaTrackAsset(trackId, signal, {
        findReadyTrack: async () => null,
        headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyMediaTrackAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack('video', {
            s3Key: 'video/507f1f77bcf86cd799439099/507f1f77bcf86cd799439012'
        }),
        headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyMediaTrackAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack('video'),
        headObject
    }, 'audio'), { status: 'notFound' });
    assert.equal(headCalls, 0);
});

test('canonical MediaTrack resolution returns only the one selected Audio or Video object', async () => {
    for (const mediaType of ['audio', 'video'] as const) {
        const calls: unknown[][] = [];
        const track = readyTrack(mediaType);
        const result = await resolveReadyMediaTrackAsset(trackId.toUpperCase(), signal, {
            findReadyTrack: async (id) => {
                calls.push(['find', id]);
                return track;
            },
            headObject: async (params, receivedSignal) => {
                calls.push(['head', params, receivedSignal]);
                return { ContentLength: 4096, ETag: '"etag"' };
            }
        });

        assert.equal(result.status, 'ready');
        if (result.status !== 'ready') continue;
        assert.equal(result.mediaType, mediaType);
        assert.equal(result.contentType, mediaType === 'video' ? 'video/mp4' : 'audio/mpeg');
        assert.deepEqual(calls, [
            ['find', trackId],
            ['head', {
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: track.s3Key
            }, signal]
        ]);
    }
});

test('canonical MediaTrack resolution hides zero-length objects', async () => {
    assert.deepEqual(await resolveReadyMediaTrackAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack('video'),
        headObject: async () => ({ ContentLength: 0 })
    }), { status: 'notFound' });
});

test('canonical MediaTrack delivery distinguishes full, exact, open, suffix, and invalid ranges', () => {
    assert.deepEqual(resolveMediaTrackByteResponse(undefined, 100), {
        status: 200,
        start: 0,
        end: 99
    });
    assert.deepEqual(resolveMediaTrackByteResponse('bytes=10-', 100), {
        status: 206,
        start: 10,
        end: 99,
        contentRange: 'bytes 10-99/100'
    });
    assert.deepEqual(resolveMediaTrackByteResponse('bytes=-8', 100), {
        status: 206,
        start: 92,
        end: 99,
        contentRange: 'bytes 92-99/100'
    });
    assert.deepEqual(resolveMediaTrackByteResponse('bytes=100-', 100), {
        status: 416,
        start: null,
        end: null,
        contentRange: 'bytes */100'
    });
    assert.equal(resolveMediaTrackByteResponse('bytes=0-1,4-5', 100).status, 416);
});
