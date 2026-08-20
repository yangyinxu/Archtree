import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveReadyVideoAsset,
    resolveVideoByteResponse,
    uploadSoundtrackVideoFile
} from '../src/controllers/soundtrackVideoController';

const trackId = '507f1f77bcf86cd799439011';
const videoKey = `video/${trackId}/507f1f77bcf86cd799439012`;
const signal = new AbortController().signal;

const readyTrack = (overrides: Record<string, unknown> = {}) => ({
    _id: trackId,
    videoAsset: {
        active: {
            status: 'ready',
            s3Key: videoKey,
            contentType: 'video/mp4',
            byteLength: 4096,
            durationSeconds: 60,
            originalFileName: 'performance.mp4',
            updatedAt: new Date(),
            error: null
        },
        pending: null,
        cleanup: null,
        revision: 1
    },
    ...overrides
});

test('public video resolution rejects invalid, absent, non-ready, and foreign-key records before S3', async () => {
    let headCalls = 0;
    const headObject = async () => {
        headCalls += 1;
        return { ContentLength: 4096 };
    };

    assert.deepEqual(await resolveReadyVideoAsset('invalid', signal, {
        findReadyTrack: async () => readyTrack(), headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyVideoAsset(trackId, signal, {
        findReadyTrack: async () => null, headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyVideoAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack({
            videoAsset: {
                ...readyTrack().videoAsset,
                active: { ...readyTrack().videoAsset.active, status: 'deleteFailed' }
            }
        }),
        headObject
    }), { status: 'notFound' });
    assert.deepEqual(await resolveReadyVideoAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack({
            videoAsset: {
                ...readyTrack().videoAsset,
                active: {
                    ...readyTrack().videoAsset.active,
                    s3Key: 'video/507f1f77bcf86cd799439099/507f1f77bcf86cd799439012'
                }
            }
        }),
        headObject
    }), { status: 'notFound' });
    assert.equal(headCalls, 0);
});

test('public video resolution heads only the database-confirmed exact ready key', async () => {
    const calls: unknown[][] = [];
    const result = await resolveReadyVideoAsset(trackId.toUpperCase(), signal, {
        findReadyTrack: async id => {
            calls.push(['find', id]);
            return readyTrack();
        },
        headObject: async (params, receivedSignal) => {
            calls.push(['head', params, receivedSignal]);
            return { ContentLength: 4096, ETag: '"etag"' };
        }
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(calls[0], ['find', trackId]);
    assert.deepEqual(calls[1], [
        'head',
        { Bucket: process.env.S3_BUCKET_NAME!, Key: videoKey },
        signal
    ]);
});

test('zero-length S3 video is hidden even when stale database metadata says ready', async () => {
    assert.deepEqual(await resolveReadyVideoAsset(trackId, signal, {
        findReadyTrack: async () => readyTrack(),
        headObject: async () => ({ ContentLength: 0 })
    }), { status: 'notFound' });
});

test('admin upload rejects a malformed Soundtrack ID before file metadata or database work', async () => {
    let statusCode = 200;
    let payload: any;
    const response = {
        status(code: number) {
            statusCode = code;
            return this;
        },
        json(value: unknown) {
            payload = value;
            return this;
        }
    } as any;

    await uploadSoundtrackVideoFile({
        auth: { role: 'admin', userId: '507f1f77bcf86cd799439099' },
        params: { audioTrackId: 'not-an-object-id' }
    } as any, response, (() => undefined) as any);

    assert.equal(statusCode, 400);
    assert.deepEqual(payload, { message: 'MediaTrack ID is invalid.' });
});

test('video delivery distinguishes full, exact open/suffix, and invalid byte responses', () => {
    assert.deepEqual(resolveVideoByteResponse(undefined, 100), {
        status: 200,
        start: 0,
        end: 99
    });
    assert.deepEqual(resolveVideoByteResponse('bytes=10-', 100), {
        status: 206,
        start: 10,
        end: 99,
        contentRange: 'bytes 10-99/100'
    });
    assert.deepEqual(resolveVideoByteResponse('bytes=-8', 100), {
        status: 206,
        start: 92,
        end: 99,
        contentRange: 'bytes 92-99/100'
    });
    assert.deepEqual(resolveVideoByteResponse('bytes=100-', 100), {
        status: 416,
        start: null,
        end: null,
        contentRange: 'bytes */100'
    });
    assert.equal(resolveVideoByteResponse('bytes=0-1,4-5', 100).status, 416);
});
