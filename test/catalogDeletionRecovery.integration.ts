import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { deleteArtistAndReferences } from '../src/services/artistLifecycleService';
import { deleteAlbumAndReferences } from '../src/services/albumLifecycleService';
import {
    acquireCatalogDeletionLease,
    CatalogDeletionLeaseLostError,
    CatalogDeletionOwnerType,
    catalogDeletionLeaseMilliseconds
} from '../src/services/catalogDeletionLeaseService';
import { prepareOwnerCoverArtDeletions } from '../src/services/imageStorageService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
before(async () => { harness = await startMongoReplicaSet('archtree-catalog-deletion-recovery-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => {
    await Promise.all(['artists', 'albums', 'imageAssets', 'catalogDeletionOperations']
        .map((name) => getDb()!.collection(name).deleteMany({})));
});

/** Controls a storage boundary without network calls or elapsed-time assumptions. */
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

const collectionFor = (type: CatalogDeletionOwnerType) => type === 'artist' ? 'artists' : 'albums';
const deletionFor = (type: CatalogDeletionOwnerType) => type === 'artist'
    ? deleteArtistAndReferences : deleteAlbumAndReferences;
const receiptId = (type: CatalogDeletionOwnerType, id: ObjectId) => `${type}:${id.toHexString()}`;
const receipts = () => getDb()!.collection<any>('catalogDeletionOperations');

/** Seeds only isolated catalog metadata; every S3 boundary below is explicitly injected. */
const seed = async (type: CatalogDeletionOwnerType) => {
    const id = new ObjectId();
    const imageId = new ObjectId();
    await getDb()!.collection(collectionFor(type)).insertOne({
        _id: id, name: 'Recovery fixture', title: 'Recovery fixture',
        lifecycleStatus: 'ready', referenceRevision: 0, coverArtId: imageId.toHexString()
    });
    await getDb()!.collection('imageAssets').insertOne({
        _id: imageId, ownerType: type, ownerId: id.toHexString(),
        s3Key: `images/${imageId.toHexString()}`, uploadStatus: 'ready'
    });
    return { id, imageId };
};
const storage = (type: CatalogDeletionOwnerType, deleteObject: (key: string) => Promise<void>) => ({
    deleteCoverArtObject: deleteObject
});

for (const type of ['artist', 'album'] as const) {
    test(`${type}: an active deletion rejects a duplicate and removes its receipt only after cleanup`, async () => {
        const { id, imageId } = await seed(type);
        const entered = deferred();
        const release = deferred();
        let deletes = 0;
        const active = deletionFor(type)(id.toHexString(), storage(type, async (key) => {
            assert.equal(key, `images/${imageId.toHexString()}`);
            deletes += 1;
            entered.resolve();
            await release.promise;
        }));
        try {
            await entered.promise;
            await assert.rejects(deletionFor(type)(id.toHexString()),
                (error: any) => error.code === `${type}_deletion_in_progress`);
            assert.equal(await receipts().countDocuments(), 1);
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
        } finally { release.resolve(); }
        assert.equal((await active).cleanupPending, false);
        assert.equal(deletes, 1);
        assert.equal(await receipts().countDocuments(), 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
    });

    test(`${type}: expired takeover fences the old worker's subsequent stages and failure write`, async () => {
        const { id, imageId } = await seed(type);
        const oldEntered = deferred();
        const oldRelease = deferred();
        const newEntered = deferred();
        const newRelease = deferred();
        let oldFinalizeCalls = 0;
        let oldOwnerDeleteCalls = 0;
        const old = deletionFor(type)(id.toHexString(), {
            ...storage(type, async () => { oldEntered.resolve(); await oldRelease.promise; }),
            deleteOwner: async () => { oldOwnerDeleteCalls += 1; return { deletedCount: 1 }; },
            finalizeOwnerCoverArt: async () => { oldFinalizeCalls += 1; }
        });
        let successor: ReturnType<typeof deleteArtistAndReferences> | undefined;
        try {
            await oldEntered.promise;
            const original = await receipts().findOne({ _id: receiptId(type, id) });
            await receipts().updateOne({ _id: original!._id }, { $set: { leaseUntil: new Date(0) } });
            successor = deletionFor(type)(id.toHexString(), {
                ...storage(type, async () => undefined),
                cleanupReferences: async () => { newEntered.resolve(); await newRelease.promise; }
            });
            await newEntered.promise;
            const replacement = await receipts().findOne({ _id: original!._id });
            assert.notEqual(replacement!.token, original!.token);
            oldRelease.resolve();
            assert.equal((await old).cleanupPending, true);
            assert.equal(oldOwnerDeleteCalls, 0);
            assert.equal(oldFinalizeCalls, 0);
            assert.equal((await receipts().findOne({ _id: original!._id }))!.status, 'inProgress');
            const retained = await getDb()!.collection(collectionFor(type)).findOne({ _id: id });
            assert.equal(retained!.lifecycleStatus, 'deleting');
            assert.equal(retained!.referenceRevision, 2);
            assert.equal(await getDb()!.collection('imageAssets').countDocuments({ _id: imageId }), 1);
        } finally { oldRelease.resolve(); newRelease.resolve(); }
        assert.equal((await successor!).cleanupPending, false);
        assert.equal(await receipts().countDocuments(), 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
    });

    test(`${type}: failed S3 cleanup and failed state persistence remain recoverable on lease expiry`, async () => {
        const { id, imageId } = await seed(type);
        const name = collectionFor(type);
        // A real database validator rejects the failure transition and aborts its transaction.
        await getDb()!.command({ collMod: name, validator: { lifecycleStatus: { $ne: 'deleteFailed' } } });
        try {
            const failed = await deletionFor(type)(id.toHexString(), storage(type, async () => {
                throw new Error('injected S3 deletion failure');
            }));
            assert.equal(failed.cleanupPending, true);
            assert.equal((await getDb()!.collection(name).findOne({ _id: id }))!.lifecycleStatus, 'deleting');
            assert.equal((await getDb()!.collection('imageAssets').findOne({ _id: imageId }))!.uploadStatus, 'deleteFailed');
            assert.equal((await receipts().findOne({ _id: receiptId(type, id) }))!.status, 'inProgress');
        } finally {
            await getDb()!.command({ collMod: name, validator: {} });
        }
        await receipts().updateOne({ _id: receiptId(type, id) }, { $set: { leaseUntil: new Date(0) } });
        const retry = await deletionFor(type)(id.toHexString(), storage(type, async () => undefined));
        assert.equal(retry.ownerDeleted, true);
        assert.equal(retry.cleanupPending, false);
        assert.equal(await receipts().countDocuments(), 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
    });

    test(`${type}: legacy deleting records recover after grace while recent legacy work stays excluded`, async () => {
        for (const updatedAt of [undefined, new Date(Date.now() - catalogDeletionLeaseMilliseconds - 5_000)]) {
            const { id } = await seed(type);
            await getDb()!.collection(collectionFor(type)).updateOne({ _id: id }, {
                $set: { lifecycleStatus: 'deleting', ...(updatedAt ? { lifecycleUpdatedAt: updatedAt } : {}) }
            });
            assert.equal((await deletionFor(type)(id.toHexString(), storage(type, async () => undefined))).ownerDeleted, true);
        }
        const { id } = await seed(type);
        await getDb()!.collection(collectionFor(type)).updateOne({ _id: id }, {
            $set: { lifecycleStatus: 'deleting', lifecycleUpdatedAt: new Date() }
        });
        await assert.rejects(deletionFor(type)(id.toHexString()),
            (error: any) => error.code === `${type}_deletion_in_progress`);
        assert.equal(await receipts().countDocuments(), 0, 'a rejected claim must roll back its receipt');
    });

    test(`${type}: owner removal followed by failed evidence cleanup resumes without deleting S3 again`, async () => {
        const { id, imageId } = await seed(type);
        let storageCalls = 0;
        const first = await deletionFor(type)(id.toHexString(), {
            ...storage(type, async () => { storageCalls += 1; }),
            finalizeOwnerCoverArt: async () => { throw new Error('injected evidence cleanup outage'); }
        });
        assert.equal(first.ownerDeleted, true);
        assert.equal(first.cleanupPending, true);
        assert.equal(await getDb()!.collection(collectionFor(type)).findOne({ _id: id }), null);
        assert.deepEqual((await receipts().findOne({ _id: receiptId(type, id) }))!.preparedImageIds, [imageId.toHexString()]);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
        const retry = await deletionFor(type)(id.toHexString(), {
            prepareOwnerCoverArt: async () => { throw new Error('S3 must not be revisited after confirmed preparation'); }
        });
        assert.equal(retry.ownerDeleted, true);
        assert.equal(retry.cleanupPending, false);
        assert.equal(storageCalls, 1);
        assert.equal(await receipts().countDocuments(), 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
        assert.equal((await deletionFor(type)(id.toHexString())).cleanupPending, false);
    });

    test(`${type}: ownerless takeover prevents stale finalization and terminal writes`, async () => {
        const { id, imageId } = await seed(type);
        const old = (await acquireCatalogDeletionLease(type, id))!;
        let successor: Awaited<ReturnType<typeof acquireCatalogDeletionLease>>;
        try {
            const images = await prepareOwnerCoverArtDeletions(type, id.toHexString(), imageId.toHexString(), {
                deleteObject: async () => undefined
            });
            await old.recordPreparedImages(images);
            await old.runFenced((session) => getDb()!.collection(collectionFor(type)).deleteOne(old.ownerFilter, { session }));
            await receipts().updateOne({ _id: receiptId(type, id) }, { $set: { leaseUntil: new Date(0) } });
            successor = (await acquireCatalogDeletionLease(type, id))!;
            assert.equal(successor.owner, null);
            await assert.rejects(old.finalizeImages(images), CatalogDeletionLeaseLostError);
            await assert.rejects(old.fail(new Error('late old worker')), CatalogDeletionLeaseLostError);
            await assert.rejects(old.complete(), CatalogDeletionLeaseLostError);
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
            assert.equal((await receipts().findOne({ _id: receiptId(type, id) }))!.token, successor.operation.token);
            await successor.finalizeImages(images);
            await successor.complete();
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
            assert.equal(await receipts().countDocuments(), 0);
        } finally { await old.stop(); await successor!?.stop(); }
    });

    test(`${type}: a late failed S3 response cannot poison a successor's prepared image`, async () => {
        const { id, imageId } = await seed(type);
        const old = (await acquireCatalogDeletionLease(type, id))!;
        const entered = deferred();
        const release = deferred();
        let successor: Awaited<ReturnType<typeof acquireCatalogDeletionLease>>;
        const failedStorage = prepareOwnerCoverArtDeletions(type, id.toHexString(), imageId.toHexString(), {
            updateAsset: old.updateImage,
            deleteObject: async () => { entered.resolve(); await release.promise; throw new Error('late S3 failure'); }
        });
        try {
            await entered.promise;
            await receipts().updateOne({ _id: receiptId(type, id) }, { $set: { leaseUntil: new Date(0) } });
            successor = (await acquireCatalogDeletionLease(type, id))!;
            const prepared = await prepareOwnerCoverArtDeletions(type, id.toHexString(), imageId.toHexString(), {
                updateAsset: successor.updateImage, deleteObject: async () => undefined
            });
            await successor.recordPreparedImages(prepared);
            await successor.runFenced((session) => getDb()!.collection(collectionFor(type))
                .deleteOne(successor!.ownerFilter, { session }));
            release.resolve();
            await assert.rejects(failedStorage, /late S3 failure/);
            assert.equal((await getDb()!.collection('imageAssets').findOne({ _id: imageId }))!.uploadStatus, 'deleting');
            await successor.finalizeImages(prepared);
            await successor.complete();
            assert.equal(await receipts().countDocuments(), 0);
        } finally { release.resolve(); await old.stop(); await successor!?.stop(); }
    });

    test(`${type}: ownerless retry rechecks exact S3 identity after a historical image deletion failure`, async () => {
        const { id, imageId } = await seed(type);
        const lease = (await acquireCatalogDeletionLease(type, id))!;
        try {
            await lease.recordPreparedImages([imageId.toHexString()]);
            await lease.runFenced((session) => getDb()!.collection(collectionFor(type)).deleteOne(lease.ownerFilter, { session }));
            await lease.fail(new Error('historical interrupted finalization'));
        } finally { await lease.stop(); }
        await getDb()!.collection('imageAssets').updateOne({ _id: imageId }, { $set: { uploadStatus: 'deleteFailed' } });
        let storageCalls = 0;
        const retry = await deletionFor(type)(id.toHexString(), storage(type, async (key) => {
            storageCalls += 1;
            assert.equal(key, `images/${imageId.toHexString()}`);
        }));
        assert.equal(retry.cleanupPending, false);
        assert.equal(storageCalls, 1);
        assert.equal(await receipts().countDocuments(), 0);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
    });
}

test('completion cannot remove the receipt before both owner and prepared images are gone', async () => {
    const { id, imageId } = await seed('artist');
    const lease = (await acquireCatalogDeletionLease('artist', id))!;
    try {
        await assert.rejects(lease.complete(), /still has an owner/);
        await lease.recordPreparedImages([imageId.toHexString()]);
        await lease.runFenced((session) => getDb()!.collection('artists').deleteOne(lease.ownerFilter, { session }));
        await assert.rejects(lease.complete(), /prepared artwork/);
        assert.deepEqual((await receipts().findOne({ _id: receiptId('artist', id) }))!.preparedImageIds, [imageId.toHexString()]);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
    } finally { await lease.stop(); }
});

test('a failed heartbeat permanently stops that worker even if a later read could renew the token', async () => {
    const { id } = await seed('artist');
    const lease = (await acquireCatalogDeletionLease('artist', id, { heartbeatMilliseconds: 10 }))!;
    try {
        await receipts().updateOne({ _id: receiptId('artist', id) }, { $set: { leaseUntil: new Date(0) } });
        // Wait only for the deliberately short heartbeat, not the production lease interval.
        await delay(100);
        await receipts().updateOne({ _id: receiptId('artist', id) }, {
            $set: { leaseUntil: new Date(Date.now() + catalogDeletionLeaseMilliseconds) }
        });
        await assert.rejects(lease.assertHeld(), CatalogDeletionLeaseLostError);
        assert.equal(await getDb()!.collection('artists').countDocuments(), 1);
        assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
    } finally { await lease.stop(); }
});
