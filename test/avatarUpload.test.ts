import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { avatarUpload, maxAvatarRequestMb, maxAvatarUploadMb } from '../src/middleware/imageUpload';
import { requireUploadSize } from '../src/middleware/audioUpload';

const boundary = 'FinitudeAvatarBoundary-fixture';
const filePart = (size = 3) => [
    'Content-Disposition: form-data; name="avatar"; filename="avatar.jpg"',
    'Content-Type: image/jpeg', '', 'x'.repeat(size)
].join('\r\n');

/** Mirrors the native Data and Web Blob single-file multipart contract. */
const parse = async (parts: string[]) => {
    const body = Buffer.from([...parts.map(part => `--${boundary}\r\n${part}\r\n`), `--${boundary}--\r\n`].join(''));
    const request: any = Readable.from([body]);
    request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    request.method = 'PUT';
    await new Promise<void>((resolve, reject) => avatarUpload.single('avatar')(request, {} as any, error => error ? reject(error) : resolve()));
    return request;
};

test('avatar parser retains native and Web one-file requests at the image ceiling', async () => {
    const request = await parse([filePart(maxAvatarUploadMb * 1024 * 1024)]);
    assert.equal(request.file.size, maxAvatarUploadMb * 1024 * 1024);
    assert.deepEqual(Object.keys(request.body), []);
});

test('avatar parser rejects text fields and extra files before retaining arbitrary bodies', async () => {
    await assert.rejects(parse(['Content-Disposition: form-data; name="unexpected"\r\n\r\nvalue']),
        (error: any) => error.code === 'LIMIT_FIELD_COUNT');
    await assert.rejects(parse([filePart(), filePart()]),
        (error: any) => ['LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT'].includes(error.code));
    await assert.rejects(parse([filePart(maxAvatarUploadMb * 1024 * 1024 + 1)]),
        (error: any) => error.code === 'LIMIT_FILE_SIZE');
});

test('avatar request envelope rejects oversized or unbounded streams before parsing', () => {
    for (const length of [undefined, '0', 'invalid', String(maxAvatarRequestMb * 1024 * 1024 + 1)]) {
        let parsed = false;
        let status = 0;
        const response: any = { status: (code: number) => { status = code; return response; }, json: () => undefined };
        requireUploadSize(maxAvatarRequestMb)({ get: () => length } as any, response, () => { parsed = true; });
        assert.equal(parsed, false);
        assert.equal(status, length === String(maxAvatarRequestMb * 1024 * 1024 + 1) ? 413 : 411);
    }
});
