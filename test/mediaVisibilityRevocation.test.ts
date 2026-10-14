import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getS3 } from '../src/infrastructure/s3';
import { AudioTrack } from '../src/models/audioTrack';
import { streamMediaTrack } from '../src/controllers/mediaTrackController';
import { streamAudioTrack, downloadAudioTrack } from '../src/controllers/audioTrackController';
import { streamSoundtrackVideo } from '../src/controllers/soundtrackVideoController';

const id = '507f1f77bcf86cd799439011';

/** Exercises the real handlers with isolated storage/model seams, without credentials or a network. */
test('all canonical and legacy media GET handlers reauthorize after GET before exposing headers or bytes', async context => {
    let row: any;
    let source: Readable;
    context.mock.method(AudioTrack, 'findReadyPublicById', async () => row);
    context.mock.method(getS3(), 'send', (async (command: unknown) => {
        if (command instanceof HeadObjectCommand) return { ContentLength: 7, ETag: '"media"' };
        row = null; // A successful hide/delete commits while GET was pending.
        source = Readable.from(['private']);
        return { Body: source, ContentLength: 7, ETag: '"media"' };
    }) as any);
    for (const handler of [streamMediaTrack, streamAudioTrack, downloadAudioTrack, streamSoundtrackVideo]) {
        const video = handler === streamSoundtrackVideo;
        row = { _id: id, mediaType: video ? 'video' : 'audio', contentType: video ? 'video/mp4' : 'audio/mpeg',
            uploadStatus: 'ready', publicationStatus: 'ready', s3Key: video ? `video/${id}/507f1f77bcf86cd799439012` : id };
        const req = Object.assign(new EventEmitter(), { params: { mediaTrackId: id, audioTrackId: id },
            query: {}, headers: { range: 'bytes=0-6' } }) as any;
        const headers = new Map<string, unknown>();
        const chunks: Buffer[] = [];
        const res = Object.assign(new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }), {
            locals: {}, statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            setHeader(key: string, value: unknown) { headers.set(key, value); return this; }
        }) as any;
        await handler(req, res, error => { throw error ?? new Error('Unexpected delegation'); });
        assert.equal(res.statusCode, 404, handler.name);
        assert.equal(chunks.length, 0, handler.name);
        for (const key of ['Content-Range', 'ETag', 'Content-Length', 'Content-Disposition', 'Content-Type']) {
            assert.equal(headers.has(key), false, `${handler.name} exposed ${key}`);
        }
        assert.equal(source!.destroyed, true);
        assert.equal(req.listenerCount('aborted'), 0);
    }
});
