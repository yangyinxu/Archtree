import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { AvatarLeaseLostError, beginAvatarMutation, completeAvatarMutation, releaseAvatarMutation,
    setAvatarMutationPhase, withAvatarMutationLease } from '../src/services/avatarMutationService';
import { runAvatarOperation } from '../src/services/avatarOperationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
before(async () => { harness = await startMongoReplicaSet('archtree-avatar-recovery-test'); });
after(async () => { await harness?.stop(); });
const account = async () => {
    const _id = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id, email: `${_id}@example.test`, username: String(_id), avatarRevision: 0, avatarAssetId: null });
    return _id.toHexString();
};

test('expired reservation is taken over without TTL expiry and rejects the old worker transaction', async () => {
    const userId = await account();
    const first = (await beginAvatarMutation(userId, 'old', 'replace', 0)).lease!;
    let receipt = await getDb()!.collection('avatarMutations').findOne({ _id: first.mutationId } as any);
    assert.equal(receipt?.expiresAt, undefined);
    await getDb()!.collection('avatarMutations').updateOne({ _id: first.mutationId } as any, { $set: { leaseUntil: new Date(0) } });
    const resumed = await beginAvatarMutation(userId, 'new', 'delete', 0);
    assert.equal(resumed.recovery, true);
    assert.equal(resumed.lease?.mutationId, first.mutationId);
    assert.notEqual(resumed.lease?.leaseToken, first.leaseToken);
    let changed = false;
    await assert.rejects(withAvatarMutationLease(first, async () => { changed = true; }), AvatarLeaseLostError);
    assert.equal(changed, false);
    await assert.rejects(releaseAvatarMutation(first), AvatarLeaseLostError);
    const result = await runAvatarOperation(resumed.lease!, undefined, true);
    assert.equal(result.statusCode, 409);
    await completeAvatarMutation(resumed.lease!, result);
    receipt = await getDb()!.collection('avatarMutations').findOne({ _id: first.mutationId } as any);
    assert.equal(receipt?.status, 'completed');
    assert.ok(receipt?.expiresAt instanceof Date);
    const next = await beginAvatarMutation(userId, 'new', 'delete', 0);
    assert.equal(next.recovery, false);
    await releaseAvatarMutation(next.lease!);
});

test('acknowledged image from an interrupted upload is published behind the resumed lease', async () => {
    const userId = await account();
    const lease = (await beginAvatarMutation(userId, 'upload', 'replace', 0)).lease!;
    const imageId = new ObjectId();
    await setAvatarMutationPhase(lease, 'uploading', { assetId: imageId.toHexString() }, async session => {
        await getDb()!.collection('imageAssets').insertOne({ _id: imageId, ownerId: userId, ownerType: 'user',
            s3Key: `avatars/${imageId}`, avatarMutationId: lease.mutationId, uploadStatus: 'failed', uploadOutcomeUnknown: false,
            storageIdentity: { versionId: 'version-1', etag: '"fixture"' } }, { session });
    });
    await getDb()!.collection('avatarMutations').updateOne({ _id: lease.mutationId } as any, { $set: { leaseUntil: new Date(0) } });
    const resumed = (await beginAvatarMutation(userId, 'upload', 'replace', 0)).lease!;
    const result = await runAvatarOperation(resumed, undefined, true);
    assert.equal(result.statusCode, 200);
    const owner = await getDb()!.collection('users').findOne({ _id: new ObjectId(userId) });
    assert.equal(owner?.avatarAssetId, imageId.toHexString());
    assert.equal(owner?.avatarRevision, 1);
    assert.equal((await getDb()!.collection('imageAssets').findOne({ _id: imageId }))?.uploadStatus, 'ready');
    assert.equal((await getDb()!.collection('avatarMutations').findOne({ _id: lease.mutationId } as any))?.phase, 'promoted');
    await assert.rejects(setAvatarMutationPhase(lease, 'cleared'), AvatarLeaseLostError);
    await completeAvatarMutation(resumed, result);
});

test('unknown upload is retained after recovery, while a fresh explicit key is unblocked', async () => {
    const userId = await account();
    const lease = (await beginAvatarMutation(userId, 'lost-put', 'replace', 0)).lease!;
    const imageId = new ObjectId();
    await setAvatarMutationPhase(lease, 'uploading', { assetId: imageId.toHexString() }, async session => {
        await getDb()!.collection('imageAssets').insertOne({ _id: imageId, ownerId: userId, ownerType: 'user',
            s3Key: `avatars/${imageId}`, avatarMutationId: lease.mutationId, uploadStatus: 'pending', uploadOutcomeUnknown: true }, { session });
    });
    await releaseAvatarMutation(lease);
    const resumed = (await beginAvatarMutation(userId, 'next-upload', 'replace', 0)).lease!;
    const result = await runAvatarOperation(resumed, undefined, true);
    assert.equal(result.statusCode, 503);
    await completeAvatarMutation(resumed, result);
    assert.equal((await getDb()!.collection('imageAssets').findOne({ _id: imageId }))?.uploadOutcomeUnknown, true);
    const next = await beginAvatarMutation(userId, 'next-upload', 'replace', 0);
    assert.equal(next.isOwner, true); assert.equal(next.recovery, false);
    await releaseAvatarMutation(next.lease!);
});

test('late cleanup worker cannot claim an image staged after its owner snapshot', async () => {
    const { cleanupDetachedAvatarAssets } = await import('../src/services/avatarStorageService');
    const userId = await account();
    const old = (await beginAvatarMutation(userId, 'older', 'replace', 0)).lease!;
    let resume!: () => void; let observed!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const observedOwner = new Promise<void>(resolve => { observed = resolve; });
    let deletes = 0;
    const cleanup = cleanupDetachedAvatarAssets(userId, {
        afterOwnerRead: async () => { observed(); await paused; },
        deleteObject: async () => { deletes += 1; }
    }, old);
    await observedOwner;
    await getDb()!.collection('avatarMutations').updateOne({ _id: old.mutationId } as any, { $set: { leaseUntil: new Date(0) } });
    const successor = (await beginAvatarMutation(userId, 'newer', 'replace', 0)).lease!;
    await completeAvatarMutation(successor, { statusCode: 409 });
    const current = (await beginAvatarMutation(userId, 'newer', 'replace', 0)).lease!;
    const imageId = new ObjectId();
    await setAvatarMutationPhase(current, 'uploading', { assetId: String(imageId) }, async session => {
        await getDb()!.collection('imageAssets').insertOne({ _id: imageId, ownerType: 'user', ownerId: userId,
            s3Key: `avatars/${imageId}`, avatarMutationId: current.mutationId, uploadStatus: 'ready', uploadOutcomeUnknown: false,
            storageIdentity: { versionId: 'current-version', etag: '"new"' } }, { session });
    });
    resume();
    assert.equal((await cleanup).cleanupPending, true);
    assert.equal(deletes, 0);
    assert.equal((await getDb()!.collection('imageAssets').findOne({ _id: imageId }))?.uploadStatus, 'ready');
    assert.equal((await runAvatarOperation(current, undefined, true)).statusCode, 200);
    await completeAvatarMutation(current, { statusCode: 200 });
});

test('a claimed deleting image cannot be promoted by recovery while S3 is in flight', async () => {
    const { prepareAvatarAssetDeletion } = await import('../src/services/avatarStorageService');
    const userId = await account();
    const lease = (await beginAvatarMutation(userId, 'claim', 'replace', 0)).lease!;
    const imageId = new ObjectId();
    await setAvatarMutationPhase(lease, 'uploading', { assetId: String(imageId) }, async session => {
        await getDb()!.collection('imageAssets').insertOne({ _id: imageId, ownerType: 'user', ownerId: userId,
            s3Key: `avatars/${imageId}`, avatarMutationId: lease.mutationId, uploadStatus: 'ready', uploadOutcomeUnknown: false,
            storageIdentity: { versionId: 'delete-version', etag: '"old"' } }, { session });
    });
    let finish!: () => void; let claimed!: () => void;
    const awaitingS3 = new Promise<void>(resolve => { finish = resolve; });
    const afterClaim = new Promise<void>(resolve => { claimed = resolve; });
    const deletion = prepareAvatarAssetDeletion(String(imageId), userId, {
        deleteObject: async () => { claimed(); await awaitingS3; }
    }, { lease, detached: true });
    await afterClaim;
    assert.equal((await runAvatarOperation(lease, undefined, true)).statusCode, 503);
    assert.equal((await getDb()!.collection('users').findOne({ _id: new ObjectId(userId) }))?.avatarAssetId, null);
    finish(); await deletion;
    await completeAvatarMutation(lease, { statusCode: 503 });
});

test('real avatar upload/promotion/deletion persists and deletes exact synthetic S3 versions', async () => {
    const sharp = (await import('sharp')).default;
    const { getS3 } = await import('../src/infrastructure/s3');
    const { executeAvatarMutation } = await import('../src/services/avatarOperationService');
    const s3 = getS3(); const previousSend = s3.send;
    const calls: any[] = [];
    (s3 as any).send = async (command: any) => {
        calls.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === 'PutObjectCommand') return { ETag: '"avatar-bytes"', VersionId: 'avatar-version-1' };
        if (command.constructor.name === 'DeleteObjectCommand') return {};
        throw new Error('Unexpected S3 command: no network permitted');
    };
    try {
        const userId = await account();
        const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).png().toBuffer();
        const file = { buffer, size: buffer.length, originalname: 'crop.png', mimetype: 'image/png' } as Express.Multer.File;
        const created = await executeAvatarMutation(userId, 'replace-real', 'replace', 0, file);
        assert.equal(created.statusCode, 200);
        const image = await getDb()!.collection('imageAssets').findOne({ ownerId: userId });
        assert.deepEqual(image?.storageIdentity, { etag: '"avatar-bytes"', versionId: 'avatar-version-1' });
        assert.equal(image?.uploadOutcomeUnknown, false);
        assert.equal(calls[0].input.IfNoneMatch, '*');
        const deleted = await executeAvatarMutation(userId, 'delete-real', 'delete', 1);
        assert.equal(deleted.statusCode, 200); assert.equal(deleted.body?.avatar, null);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments({ ownerId: userId }), 0);
        assert.equal(calls.find(call => call.name === 'DeleteObjectCommand').input.VersionId, 'avatar-version-1');
    } finally { s3.send = previousSend; }
});

test('lost PUT acknowledgement retains the object identity evidence and does not lock fresh intents', async () => {
    const sharp = (await import('sharp')).default;
    const { getS3 } = await import('../src/infrastructure/s3');
    const { executeAvatarMutation } = await import('../src/services/avatarOperationService');
    const s3 = getS3(); const previousSend = s3.send;
    let puts = 0; let deletes = 0;
    (s3 as any).send = async (command: any) => {
        if (command.constructor.name === 'PutObjectCommand') {
            if (++puts === 1) throw new Error('S3 accepted PUT but its response was lost');
            return { ETag: '"new"', VersionId: 'new-version' };
        }
        if (command.constructor.name === 'DeleteObjectCommand') { deletes += 1; return {}; }
        throw new Error('Unexpected S3 command');
    };
    try {
        const userId = await account();
        const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).png().toBuffer();
        const file = { buffer, size: buffer.length, originalname: 'crop.png', mimetype: 'image/png' } as Express.Multer.File;
        assert.equal((await executeAvatarMutation(userId, 'lost', 'replace', 0, file)).statusCode, 503);
        const next = await executeAvatarMutation(userId, 'fresh', 'replace', 0, file);
        assert.equal(next.statusCode, 200); assert.equal(next.body?.cleanupPending, true);
        assert.equal(deletes, 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments({ ownerId: userId, uploadOutcomeUnknown: true }), 1);
        assert.equal(await getDb()!.collection('avatarMutations').countDocuments({ userId, status: 'pending' }), 0);
    } finally { s3.send = previousSend; }
});

test('cover-art storage records acknowledged versions and removes them without a delete marker', async () => {
    const sharp = (await import('sharp')).default;
    const { getS3 } = await import('../src/infrastructure/s3');
    const { uploadCoverArt, deleteCoverArt } = await import('../src/services/imageStorageService');
    const s3 = getS3(); const previousSend = s3.send;
    const calls: any[] = [];
    (s3 as any).send = async (command: any) => {
        calls.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === 'PutObjectCommand') return { ETag: '"cover"', VersionId: 'cover-version' };
        if (command.constructor.name === 'DeleteObjectCommand') return {};
        throw new Error('Unexpected S3 command');
    };
    try {
        const userId = await account();
        const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).png().toBuffer();
        const file = { buffer, size: buffer.length, originalname: 'cover.png', mimetype: 'image/png' } as Express.Multer.File;
        const cover = await uploadCoverArt('album', String(new ObjectId()), file, userId, { allowMissingOwner: true });
        const record = await getDb()!.collection('imageAssets').findOne({ _id: new ObjectId(cover.imageId) });
        assert.deepEqual(record?.storageIdentity, { etag: '"cover"', versionId: 'cover-version' });
        assert.equal(calls[0].input.IfNoneMatch, '*');
        await deleteCoverArt(cover.imageId);
        assert.equal(calls[1].input.VersionId, 'cover-version');
        assert.equal(await getDb()!.collection('imageAssets').countDocuments({ _id: new ObjectId(cover.imageId) }), 0);
    } finally { s3.send = previousSend; }
});
