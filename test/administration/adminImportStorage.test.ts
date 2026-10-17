import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../../src/infrastructure/s3';
import { defaultImportObjectStorage, type ImportObjectTarget } from '../../src/administration/import/adminImportStorage';

test('canonical copy uses one SDK PUT attempt so a late retry cannot recreate a cancelled key', async t => {
    const bytes = Buffer.from('Synthetic bounded audio bytes'); let puts = 0;
    const server = createServer(async (req, res) => {
        assert.equal(req.method, 'PUT'); puts++;
        assert.equal(req.headers['if-none-match'], '*');
        const body: Buffer[] = []; for await (const chunk of req) body.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(body), bytes);
        res.statusCode = 503; res.setHeader('Content-Type', 'application/xml');
        res.end('<Error><Code>ServiceUnavailable</Code><Message>Synthetic retryable response</Message></Error>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const shared = getS3(), previousEndpoint = shared.config.endpoint;
    shared.config.endpoint = async () => ({ protocol: 'http:', hostname: '127.0.0.1', port: address.port, path: '/' });
    t.mock.method(shared, 'send', async command => {
        assert.ok(command instanceof GetObjectCommand); assert.equal(command.input.IfMatch, '"source"');
        assert.equal(command.input.VersionId, 'source-version');
        // A replayable byte body makes SDK retry policy observable, independently of stream retry restrictions.
        return { ContentLength: bytes.length, Body: bytes };
    });
    const originalSend = S3Client.prototype.send;
    t.mock.method(S3Client.prototype, 'send', async function(this: S3Client, command: any, options: any) {
        assert.ok(command instanceof PutObjectCommand); assert.equal(await this.config.maxAttempts(), 1);
        return originalSend.call(this, command, options);
    });
    const target: ImportObjectTarget = { bucket: 'synthetic-canonical', key: `audio/${'1'.repeat(24)}/${'2'.repeat(24)}`,
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, contentType: 'audio/wav',
        importId: '3'.repeat(24), slotId: randomUUID(), operationId: randomUUID() };
    try {
        await assert.rejects(defaultImportObjectStorage.copy({ ...target, bucket: 'synthetic-private', key: 'imports/source', etag: '"source"', versionId: 'source-version' }, target),
            (error: any) => error.$metadata?.attempts === 1);
        assert.equal(puts, 1);
    } finally {
        shared.config.endpoint = previousEndpoint;
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
