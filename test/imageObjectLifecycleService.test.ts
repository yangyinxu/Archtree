import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { deleteImageStorageObject, imageStorageIdentity, inspectImageStorageVersions } from '../src/services/imageObjectLifecycleService';
import { reconcileImageStorageIdentity } from '../src/services/imageStorageRecoveryService';

const asset = () => ({ _id: new ObjectId('507f1f77bcf86cd799439011'), ownerType: 'user' as const,
    ownerId: '507f1f77bcf86cd799439099', s3Key: 'avatars/507f1f77bcf86cd799439011' });
const metadata = { imageid: String(asset()._id), ownertype: 'user', ownerid: asset().ownerId };

test('acknowledged PUT identity distinguishes exact null and numbered versions', () => {
    assert.deepEqual(imageStorageIdentity({ ETag: '"a"' }), { etag: '"a"', versionId: null });
    assert.deepEqual(imageStorageIdentity({ ETag: '"a"', VersionId: 'v1' }), { etag: '"a"', versionId: 'v1' });
    assert.throws(() => imageStorageIdentity({ VersionId: 'v1' }));
    assert.throws(() => imageStorageIdentity({ ETag: '"a"', VersionId: '' }));
});

test('deletion removes exact stored versions including null, never a key-only marker', async () => {
    const calls: any[] = [];
    await deleteImageStorageObject({ ...asset(), storageCleanupVersions: [
        { etag: '"a"', versionId: 'v1' }, { etag: '"b"', versionId: null }
    ], storageDeleteMarkers: ['marker1'] }, async command => {
        // AWS rejects version-specific conditional DELETE; permissive object-map
        // stubs must not hide a request the actual service cannot execute.
        if (command.input.VersionId && command.input.IfMatch) throw new Error('NotImplemented');
        calls.push(command.input);
    });
    assert.deepEqual(calls.map(call => [call.VersionId, call.IfMatch]), [['v1', undefined], ['null', undefined], ['marker1', undefined]]);
    assert.ok(calls.every(call => call.Key === asset().s3Key));
});

test('unknown PUT and legacy missing identity retain evidence without sending DELETE', async () => {
    for (const identity of [{}, { storageIdentity: { etag: '"a"', versionId: 'v1' }, uploadOutcomeUnknown: true }]) {
        await assert.rejects(deleteImageStorageObject({ ...asset(), ...identity }, async () => assert.fail('unsafe DELETE')));
    }
});

test('version deletion failures remain retryable with the same version identities', async () => {
    const input = { ...asset(), storageIdentity: { etag: '"a"', versionId: 'v1' } };
    await assert.rejects(deleteImageStorageObject(input, async () => { throw new Error('lost acknowledgement'); }));
    let version: string | undefined;
    await deleteImageStorageObject(input, async command => {
        assert.equal(command.input.IfMatch, undefined);
        version = command.input.VersionId;
    });
    assert.equal(version, 'v1');
});

test('legacy inspection includes old versions and marker behind exact-key metadata checks', async () => {
    const inventory = await inspectImageStorageVersions(asset(), {
        list: async () => ({ Versions: [{ Key: asset().s3Key, VersionId: 'v1', ETag: '"a"', IsLatest: false }],
            DeleteMarkers: [{ Key: asset().s3Key, VersionId: 'marker1', IsLatest: true }] }),
        head: async () => ({ ETag: '"a"', Metadata: metadata })
    });
    assert.deepEqual(inventory, { versions: [{ versionId: 'v1', etag: '"a"' }], deleteMarkers: ['marker1'], current: undefined });
    await assert.rejects(inspectImageStorageVersions(asset(), {
        list: async () => ({ Versions: [{ Key: asset().s3Key, VersionId: 'v1', ETag: '"a"' }] }),
        head: async () => ({ ETag: '"a"', Metadata: { ...metadata, ownerid: 'another-account' } })
    }));
});

test('malformed/truncated inventories never imply confirmed absence', async () => {
    await assert.rejects(inspectImageStorageVersions(asset(), { list: async () => ({ IsTruncated: true }), head: async () => assert.fail() }));
    await assert.rejects(inspectImageStorageVersions(asset(), {
        list: async () => ({ IsTruncated: true, NextKeyMarker: 'same', NextVersionIdMarker: 'same' }), head: async () => assert.fail()
    }));
});

test('explicit recovery defaults read-only and needs quiescence before persisting legacy versions', async () => {
    let writes = 0;
    let written: any;
    const row = { ...asset(), uploadStatus: 'failed', uploadOutcomeUnknown: true };
    const db: any = { collection: (name: string) => ({ findOne: async () => name === 'imageAssets' ? row : null,
        updateOne: async (_filter: any, update: any) => { writes += 1; written = update.$set; return { matchedCount: 1 }; } }) };
    const inventory = async () => ({ versions: [{ versionId: 'v1', etag: '"a"' }], deleteMarkers: [], current: undefined });
    assert.equal((await reconcileImageStorageIdentity(db, String(row._id), false, false, inventory)).applied, false);
    assert.equal(writes, 0);
    await assert.rejects(reconcileImageStorageIdentity(db, String(row._id), true, false, inventory));
    assert.equal((await reconcileImageStorageIdentity(db, String(row._id), true, true, inventory)).applied, true);
    assert.equal(writes, 1);
    assert.equal(written.uploadOutcomeUnknown, false);
    assert.deepEqual(written.storageCleanupVersions, [{ versionId: 'v1', etag: '"a"' }]);
});

test('recovery refuses active avatar workers and changed lifecycle snapshots', async () => {
    const row = { ...asset(), uploadStatus: 'failed' };
    let active = true;
    const db: any = { collection: (name: string) => ({ findOne: async () => name === 'imageAssets' ? row : active ? {} : null,
        updateOne: async () => ({ matchedCount: 0 }) }) };
    const inventory = async () => ({ versions: [], deleteMarkers: [], current: undefined });
    await assert.rejects(reconcileImageStorageIdentity(db, String(row._id), true, true, inventory));
    active = false;
    await assert.rejects(reconcileImageStorageIdentity(db, String(row._id), true, true, inventory));
});
