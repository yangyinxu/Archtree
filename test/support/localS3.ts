import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export interface LocalS3Object { bytes: Buffer; etag: string; versionId: string; contentType: string }

/** Owned loopback S3 protocol fixture: real SDK uploads and conditional byte streams, no external account. */
export const startLocalS3 = async (bucket = 'room-media-test') => {
    const objects = new Map<string, LocalS3Object>();
    const requests: Array<{ method: string; key: string; ifMatch?: string; versionId: string | null; range?: string }> = [];
    const controls: { beforeRead?: (method: string, key: string) => Promise<void>; dropPutResponses?: boolean } = {};
    let sequence = 0;
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url!, 'http://127.0.0.1');
            if (!url.pathname.startsWith(`/${bucket}/`)) { res.writeHead(404).end(); return; }
            const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
            const versionId = url.searchParams.get('versionId');
            const ifMatch = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : undefined;
            requests.push({ method: req.method!, key, ifMatch, versionId, range: req.headers.range });
            if (req.method === 'PUT') {
                if (req.headers['if-none-match'] === '*' && objects.has(key)) {
                    res.writeHead(412).end(); return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                let bytes = Buffer.concat(chunks);
                if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) {
                    const decoded: Buffer[] = [];
                    let offset = 0;
                    while (offset < bytes.length) {
                        const end = bytes.indexOf('\r\n', offset);
                        const size = Number.parseInt(bytes.toString('ascii', offset, end).split(';')[0], 16);
                        if (!Number.isSafeInteger(size) || size < 0 || end < offset || end + 2 + size > bytes.length) throw new Error('Invalid fixture upload framing.');
                        if (!size) break;
                        decoded.push(bytes.subarray(end + 2, end + 2 + size));
                        offset = end + 2 + size + 2;
                    }
                    bytes = Buffer.concat(decoded);
                }
                const object = {
                    bytes, etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
                    versionId: `fixture-${++sequence}`, contentType: String(req.headers['content-type'] ?? 'application/octet-stream')
                };
                objects.set(key, object);
                if (controls.dropPutResponses) { req.socket.destroy(); return; }
                res.writeHead(200, { ETag: object.etag, 'x-amz-version-id': object.versionId }).end(); return;
            }
            if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
            await controls.beforeRead?.(req.method!, key);
            const object = objects.get(key);
            if (!object || (versionId && versionId !== object.versionId)) { res.writeHead(404).end(); return; }
            if (ifMatch && ifMatch !== object.etag) { res.writeHead(412).end(); return; }
            const headers: Record<string, string | number> = {
                ETag: object.etag, 'x-amz-version-id': object.versionId, 'Content-Type': object.contentType,
                'Content-Length': object.bytes.length, 'Accept-Ranges': 'bytes'
            };
            if (req.method === 'HEAD') { res.writeHead(200, headers).end(); return; }
            if (req.method !== 'GET') { res.writeHead(405).end(); return; }
            let bytes = object.bytes;
            const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
            if (range) {
                const start = Number(range[1]); const end = Number(range[2]);
                if (start > end || end >= bytes.length) { res.writeHead(416).end(); return; }
                headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
                bytes = bytes.subarray(start, end + 1); headers['Content-Length'] = bytes.length;
            }
            res.writeHead(range ? 206 : 200, headers).end(bytes);
        } catch {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('S3 fixture failed to bind.');
    return {
        endpoint: `http://127.0.0.1:${address.port}`, bucket, objects, requests, controls,
        get uploadedVersionCount() { return sequence; },
        stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    };
};
