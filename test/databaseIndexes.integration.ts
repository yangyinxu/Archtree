import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getDb } from '../src/infrastructure/database';
import {
  DatabaseIndexInitializationError, initializeDatabaseIndexes, requiredIndexRevision,
  verifyRequiredDatabaseIndexes
} from '../src/infrastructure/databaseIndexes';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

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
});

test('real Mongo indexes are verified, missing uniqueness fails closed, and duplicates are never deleted', async () => {
  const db = getDb()!;
  await initializeDatabaseIndexes(db);
  const receipt = await db.collection<{ _id: string }>('schemaMigrations')
    .findOne({ _id: requiredIndexRevision });
  assert.ok(receipt);
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
