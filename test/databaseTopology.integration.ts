import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { startMongoReplicaSet, startMongoTestDatabase } from './support/mongoReplicaSet';
import { checkDatabaseReadiness, getDatabaseClient, getDb } from '../src/infrastructure/database';
import { DatabaseTopologyUnavailableError, verifyDatabaseTransactionTopology } from '../src/infrastructure/databaseTopology';
import { startServer } from '../src/server';

test('real replica-set startup is ready and supports an actual committed transaction', async () => {
  const harness = await startMongoReplicaSet('archtree-topology-replica-set');
  try {
    await verifyDatabaseTransactionTopology(getDb()!);
    assert.equal(await checkDatabaseReadiness(), true);
    await getDb()!.createCollection('syntheticTopologyProbe');
    const session = getDatabaseClient().startSession();
    try {
      await session.withTransaction(async () => {
        await getDb()!.collection('syntheticTopologyProbe').insertOne({ value: 'synthetic' }, { session });
      });
    } finally { await session.endSession(); }
    assert.equal(await getDb()!.collection('syntheticTopologyProbe').countDocuments(), 1);
  } finally { await harness.stop(); }
});

test('real standalone startup is rejected before the application or index writes become available', async () => {
  const harness = await startMongoTestDatabase('archtree-topology-standalone', {
    topology: 'standalone', connectApplication: false
  });
  let applicationConstructed = false;
  try {
    await assert.rejects(startServer({
      port: 0,
      createApplication: () => { applicationConstructed = true; throw new Error('must not build application'); }
    }), DatabaseTopologyUnavailableError);
    assert.equal(applicationConstructed, false);
    assert.equal(getDb(), null);
    assert.equal(await checkDatabaseReadiness(), false);
    assert.throws(getDatabaseClient, /not connected/);
    const client = new MongoClient(process.env.DB_CONN_STRING!);
    try {
      await client.connect();
      assert.deepEqual(await client.db(process.env.DB_NAME).listCollections().toArray(), []);
    } finally { await client.close(); }
  } finally { await harness.stop(); }
});
