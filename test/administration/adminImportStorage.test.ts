import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../../src/infrastructure/s3';
import { defaultImportObjectStorage, type ImportObjectTarget } from '../../src/administration/import/adminImportStorage';
import { importSourcesLocked, importUploadSettled, type ImportAsset, type ImportMedia } from '../../src/administration/import/adminImportMediaTypes';
import { ADMIN_IMPORT_LIMITS } from '../../src/administration/import/adminImportContract';

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

test('a missing upload settles only after its lease ends and its transfer deadline passes', () => {
    const now = new Date('2026-10-18T12:00:00.000Z'), at = (ms: number) => new Date(now.getTime() + ms);
    const asset = (fields: Partial<ImportAsset>) => ({ updatedAt: at(-1_000), leaseUntil: null, transferDeadline: at(-1), ...fields }) as ImportAsset;
    assert.equal(importUploadSettled(asset({ leaseUntil: at(1) }), now), false, 'an active lease may still PUT');
    assert.equal(importUploadSettled(asset({ transferDeadline: at(1) }), now), false, 'before the transfer deadline');
    assert.equal(importUploadSettled(asset({ leaseUntil: at(-1) }), now), true, 'after an expired lease and the deadline');
    assert.equal(importUploadSettled(asset({ transferDeadline: now }), now), true, 'at the deadline');
    assert.equal(importUploadSettled(asset({ transferDeadline: undefined, updatedAt: at(-ADMIN_IMPORT_LIMITS.uploadSettleMs + 1) }), now), false, 'legacy record inside updatedAt fallback');
    assert.equal(importUploadSettled(asset({ transferDeadline: null, updatedAt: at(-ADMIN_IMPORT_LIMITS.uploadSettleMs) }), now), true, 'legacy record after updatedAt fallback');
});
test('sources stay locked during an active publication or pending cancelled cleanup', () => {
    const media = (publication?: Partial<ImportMedia['publication']>) => ({ assets: [], ...(publication ? { publication } : {}) }) as ImportMedia;
    assert.equal(importSourcesLocked(undefined), false); assert.equal(importSourcesLocked(media()), false);
    for (const state of ['preparing', 'needsAttention', 'complete'] as const) assert.equal(importSourcesLocked(media({ state })), true, state);
    assert.equal(importSourcesLocked(media({ state: 'cancelled', cleanupPending: true })), true);
    assert.equal(importSourcesLocked(media({ state: 'cancelled', cleanupPending: false })), false);
});
