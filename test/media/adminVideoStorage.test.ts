import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getS3 } from '../../src/infrastructure/s3';
import type { AdminVideoObject } from '../../src/models/adminVideoProject';
import { defaultAdminVideoStorage } from '../../src/services/media/adminVideoStorage';

/** Confirmed synthetic identities exercise the actual S3 adapter without network or credentials. */
const asset = (versionId: string | null): AdminVideoObject => ({
    id: '507f1f77bcf86cd799439012', kind: 'source', operationId: 'synthetic-operation', bucket: 'synthetic-private',
    key: 'video-projects/synthetic/source/unique-object', filename: 'source.mov', contentType: 'video/quicktime',
    byteLength: 100, sha256: 'a'.repeat(64), state: 'deleting', etag: '"confirmed"', versionId,
    sent: true, settleAfter: new Date(0), updatedAt: new Date(0)
});

test('Video cleanup deletes the exact null version after bucket versioning changes, without creating a marker', async context => {
    const versions = new Map([['null', 'original'], ['new-version', 'later-current']]);
    const commands: DeleteObjectCommand[] = [];
    context.mock.method(getS3(), 'send', (async (command: unknown) => {
        assert.ok(command instanceof DeleteObjectCommand);
        commands.push(command);
        // S3 rejects conditional version deletion; a key-only delete would create a marker.
        assert.equal(command.input.IfMatch, undefined);
        assert.equal(command.input.VersionId, 'null');
        versions.delete(command.input.VersionId);
        return {};
    }) as any);
    await defaultAdminVideoStorage.delete('synthetic', asset(null));
    assert.equal(commands.length, 1);
    assert.deepEqual([...versions], [['new-version', 'later-current']]);
});

test('Video cleanup of a historical version retains the different current object', async context => {
    const versions = new Map([['confirmed-version', 'original'], ['current-version', 'different-current']]);
    context.mock.method(getS3(), 'send', (async (command: unknown) => {
        assert.ok(command instanceof DeleteObjectCommand);
        assert.equal(command.input.Bucket, 'synthetic-private');
        assert.equal(command.input.Key, 'video-projects/synthetic/source/unique-object');
        assert.equal(command.input.IfMatch, undefined);
        assert.equal(command.input.VersionId, 'confirmed-version');
        versions.delete(command.input.VersionId);
        return {};
    }) as any);
    await defaultAdminVideoStorage.delete('synthetic', asset('confirmed-version'));
    assert.deepEqual([...versions], [['current-version', 'different-current']]);
});

test('Video cleanup refuses an unconfirmed storage identity before any S3 deletion', async context => {
    const send = context.mock.method(getS3(), 'send', (async () => { throw new Error('Unexpected S3 request'); }) as any);
    await assert.rejects(defaultAdminVideoStorage.delete('synthetic', { ...asset(null), etag: null }), /Unknown video version/);
    assert.equal(send.mock.callCount(), 0);
});

test('a rejected exact-version cleanup propagates without falling back to a key-only deletion', async context => {
    const failure = Object.assign(new Error('Synthetic storage failure'), { name: 'ServiceUnavailable' });
    const send = context.mock.method(getS3(), 'send', (async (command: unknown) => {
        assert.ok(command instanceof DeleteObjectCommand);
        assert.equal(command.input.VersionId, 'confirmed-version');
        throw failure;
    }) as any);
    await assert.rejects(defaultAdminVideoStorage.delete('synthetic', asset('confirmed-version')), error => error === failure);
    assert.equal(send.mock.callCount(), 1);
});
