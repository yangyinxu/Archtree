import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getDb } from '../../src/infrastructure/database';
import {
  DatabaseIndexInitializationError, initializeDatabaseIndexes, requiredIndexRevision,
  verifyRequiredDatabaseIndexes
} from '../../src/infrastructure/databaseIndexes';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
before(async () => { harness = await startMongoReplicaSet('archtree-database-index-tests'); });
after(async () => { await harness?.stop(); });

test('startup provisions deletion receipts and repeated initialization preserves existing evidence', async () => {
  const db = getDb()!;
  assert.equal((await db.listCollections({ name: 'catalogDeletionOperations' }).toArray()).length, 1);
  const receipts = db.collection<{ _id: string; preparedImageIds: string[]; status: string }>('catalogDeletionOperations');
  const sentinel = { _id: 'synthetic:preserved', preparedImageIds: ['synthetic-image'], status: 'failed' };
  await receipts.insertOne(sentinel);
  await initializeDatabaseIndexes(db);
  await initializeDatabaseIndexes(db);
  await verifyRequiredDatabaseIndexes(db);
  assert.deepEqual(await receipts.findOne({ _id: sentinel._id }), sentinel);
  assert.equal(await receipts.countDocuments(), 1);
  // The metadata lookup worker's claim index also provisions its collection, so no transaction ever creates it.
  assert.equal((await db.listCollections({ name: 'adminImportLookups' }).toArray()).length, 1);
  const lookupWorker = (await db.collection('adminImportLookups').listIndexes().toArray()).find(index => index.name === 'admin_import_lookup_worker');
  assert.deepEqual([lookupWorker?.key, lookupWorker?.unique], [{ state: 1, leaseUntil: 1, retryAt: 1 }, undefined]);
});

test('real Mongo indexes are verified, missing uniqueness fails closed, and duplicates are never deleted', async () => {
  const db = getDb()!;
  await initializeDatabaseIndexes(db);
  const receipt = await db.collection<{ _id: string }>('schemaMigrations')
    .findOne({ _id: requiredIndexRevision });
  assert.ok(receipt);
  assert.equal(requiredIndexRevision, 'required-indexes-v11-musicbrainz-ids');
  const linkIndexes = await db.collection('emailLinkTokens').listIndexes().toArray();
  const byKey = (key: Record<string, number>) => linkIndexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
  assert.ok(byKey({ email: 1, purpose: 1 }), 'link cleanup within registration transactions is indexed');
  assert.equal(byKey({ userId: 1 })?.sparse, true);
  assert.equal(byKey({ expiresAt: 1 })?.expireAfterSeconds, 0, 'expired links leave through the TTL index');
  await verifyRequiredDatabaseIndexes(db);
  await db.collection('users').dropIndex('email_1');
  await assert.rejects(verifyRequiredDatabaseIndexes(db), DatabaseIndexInitializationError);
  await db.collection('users').insertMany([
    { email: 'synthetic-duplicate@example.test' }, { email: 'synthetic-duplicate@example.test' }
  ]);
  await assert.rejects(initializeDatabaseIndexes(db), DatabaseIndexInitializationError);
  assert.equal(await db.collection('users').countDocuments({}), 2);
  // Fixture cleanup is explicit; migration itself never resolves duplicates by deleting data.
  await db.collection('users').deleteMany({ email: 'synthetic-duplicate@example.test' });
  await initializeDatabaseIndexes(db);
  await verifyRequiredDatabaseIndexes(db);
});

test('MusicBrainz ID indexes refuse a same-kind duplicate and admit records without an ID', async () => {
  const db = getDb()!;
  await initializeDatabaseIndexes(db);
  for (const [collection, name] of [['artists', 'artist_musicbrainz_id'], ['organizations', 'organization_musicbrainz_id']] as const) {
    const index = (await db.collection(collection).listIndexes().toArray()).find(entry => entry.name === name);
    assert.deepEqual([index?.key, index?.unique, index?.partialFilterExpression], [{ musicBrainzId: 1 }, true, { musicBrainzId: { $type: 'string' } }]);
  }
  const id = '00000000-0000-4000-8000-0000000000a1';
  await db.collection('artists').insertMany([{ name: 'Synthetic A', musicBrainzId: id }, { name: 'Synthetic B' }, { name: 'Synthetic C' }, { name: 'Synthetic D', musicBrainzId: null }]);
  await assert.rejects(db.collection('artists').insertOne({ name: 'Synthetic E', musicBrainzId: id }), (error: { code?: number }) => error.code === 11000);
  // An Artist and an Organization may hold one ID.
  await db.collection('organizations').insertOne({ name: 'Synthetic Label', musicBrainzId: id });
  await assert.rejects(db.collection('organizations').insertOne({ name: 'Synthetic Label 2', musicBrainzId: id }), (error: { code?: number }) => error.code === 11000);
  // Existing duplicates fail startup closed and are never deleted.
  await db.collection('artists').dropIndex('artist_musicbrainz_id');
  await db.collection('artists').insertOne({ name: 'Synthetic F', musicBrainzId: id });
  await assert.rejects(initializeDatabaseIndexes(db), (error: unknown) => error instanceof DatabaseIndexInitializationError && error.indexId === 'artists:musicBrainzId');
  assert.equal(await db.collection('artists').countDocuments({ musicBrainzId: id }), 2);
  await db.collection('artists').deleteMany({ name: /^Synthetic/ });
  await db.collection('organizations').deleteMany({ name: /^Synthetic/ });
  await initializeDatabaseIndexes(db);
  await verifyRequiredDatabaseIndexes(db);
});
