import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { startMongoReplicaSet, startMongoTestDatabase } from './support/mongoReplicaSet';
import { checkDatabaseReadiness, connectToDatabase, disconnectFromDatabase, getDatabaseClient, getDb } from '../src/infrastructure/database';
import { DatabaseTopologyUnavailableError, verifyDatabaseTransactionTopology } from '../src/infrastructure/databaseTopology';
import { startServer } from '../src/server';

test('real replica-set startup is ready and supports an actual committed transaction', async () => {
  const before = process.listenerCount('SIGINT');
  const harness = await startMongoReplicaSet('archtree-topology-replica-set');
  try {
    assert.equal(process.listenerCount('SIGINT'), before + 1);
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
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('a containing server can exclusively own signals until it explicitly closes MongoDB', async () => {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const before = signals.map(signal => process.listenerCount(signal));
  const harness = await startMongoReplicaSet('archtree-topology-owned-signals', { registerSignalHandlers: false });
  try {
    assert.equal(await checkDatabaseReadiness(), true);
    assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  } finally { await harness.stop(); }
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
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


test('read-only operational connection verifies constraints without creating missing indexes or collections', async () => {
  const harness = await startMongoReplicaSet('archtree-topology-read-only');
  try {
    const database = getDb()!;
    const users = database.collection('users');
    const indexes = await users.listIndexes().toArray();
    const index = indexes.find(value => value.name !== '_id_' && value.unique === true)!;
    assert.ok(index);
    await users.dropIndex(index.name!);
    const client = new MongoClient(process.env.DB_CONN_STRING!);
    await client.connect();
    try {
      const observer = client.db(process.env.DB_NAME);
      const before = await observer.listCollections().toArray();
      await disconnectFromDatabase();
      await assert.rejects(connectToDatabase({ initializeIndexes: false, logReady: false }));
      assert.deepEqual(await observer.listCollections().toArray(), before);
      assert.equal((await observer.collection('users').listIndexes().toArray()).some(value => value.name === index.name), false);
    } finally { await client.close(); }
  } finally { await harness.stop(); }
});
