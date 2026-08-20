import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import { videoUpload } from '../src/middleware/videoUpload';

const boundary = 'finitude-video-upload-boundary';

const multipartRequest = (parts: string[]) => {
    const body = Buffer.from([
        ...parts.map((part) => `--${boundary}\r\n${part}\r\n`),
        `--${boundary}--\r\n`
    ].join(''));
    const request = Readable.from([body]) as Readable & {
        body?: Record<string, string>;
        file?: Express.Multer.File;
        headers: Record<string, string>;
        method: string;
        url: string;
    };
    request.headers = {
        'content-length': String(body.byteLength),
        'content-type': `multipart/form-data; boundary=${boundary}`
    };
    request.method = 'POST';
    request.url = '/content/manage/audioTrack/video-upload';
    return request;
};

const parseSingleVideo = (request: Readable) => new Promise<void>((resolve, reject) => {
    videoUpload.single('videoFile')(request as any, {} as any, (error: unknown) => {
        if (error) reject(error);
        else resolve();
    });
});

test('video upload accepts its required ID field and one MP4 file', async () => {
    const request = multipartRequest([
        'Content-Disposition: form-data; name="audioTrackId"\r\n\r\n507f1f77bcf86cd799439011',
        [
            'Content-Disposition: form-data; name="videoFile"; filename="performance.mp4"',
            'Content-Type: video/mp4',
            '',
            'not-yet-validated-mp4-bytes'
        ].join('\r\n')
    ]);

    try {
        await parseSingleVideo(request);
        assert.equal(request.body?.audioTrackId, '507f1f77bcf86cd799439011');
        assert.equal(request.file?.fieldname, 'videoFile');
        assert.equal(request.file?.originalname, 'performance.mp4');
        assert.equal(request.file?.mimetype, 'video/mp4');
    } finally {
        if (request.file?.path) {
            await fs.unlink(request.file.path).catch(() => undefined);
        }
    }
});

test('video upload still rejects a second text field', async () => {
    const request = multipartRequest([
        'Content-Disposition: form-data; name="audioTrackId"\r\n\r\n507f1f77bcf86cd799439011',
        'Content-Disposition: form-data; name="unexpected"\r\n\r\nvalue',
        [
            'Content-Disposition: form-data; name="videoFile"; filename="performance.mp4"',
            'Content-Type: video/mp4',
            '',
            'not-yet-validated-mp4-bytes'
        ].join('\r\n')
    ]);

    await assert.rejects(
        parseSingleVideo(request),
        (error: any) => error?.code === 'LIMIT_FIELD_COUNT'
    );
});
