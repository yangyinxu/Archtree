import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db, Document } from 'mongodb';
import { MongoClient } from 'mongodb';
import {
  DatabaseTopologyUnavailableError, verifyDatabaseTransactionTopology
} from '../src/infrastructure/databaseTopology';
import { connectToDatabase, disconnectFromDatabase, getDb, getDatabaseClient, checkDatabaseReadiness } from '../src/infrastructure/database';
import { databaseIndexes, DatabaseCollectionInitializationError } from '../src/infrastructure/databaseIndexes';

const replicaSetHello = {
  isWritablePrimary: true, setName: 'synthetic', logicalSessionTimeoutMinutes: 30, maxWireVersion: 25
};

/** A metadata-only stand-in: topology checks must not create a session or issue writes. */
const topologyDatabase = (hello: Document) => ({
  command: async (command: Document, options: Document) => {
    assert.deepEqual(command, { hello: 1 });
    assert.deepEqual(options, { maxTimeMS: 1_000, readPreference: 'primary' });
    return hello;
  }
}) as unknown as Db;

test('transaction readiness accepts writable replica sets and mongos with logical sessions', async () => {
  await verifyDatabaseTransactionTopology(topologyDatabase(replicaSetHello));
  await verifyDatabaseTransactionTopology(topologyDatabase({ ...replicaSetHello, maxWireVersion: 8 }));
  await verifyDatabaseTransactionTopology(topologyDatabase({
    isWritablePrimary: true, msg: 'isdbgrid', logicalSessionTimeoutMinutes: 30, maxWireVersion: 8
  }));
});

test('standalone, secondaries, missing sessions, and old wire versions fail closed', async () => {
  for (const hello of [
    { ...replicaSetHello, setName: undefined },
    { ...replicaSetHello, isWritablePrimary: false },
    { ...replicaSetHello, isWritablePrimary: false, ismaster: true },
    { ...replicaSetHello, logicalSessionTimeoutMinutes: null },
    { ...replicaSetHello, maxWireVersion: 6 },
    { ...replicaSetHello, maxWireVersion: 7 },
    { ...replicaSetHello, msg: 'isdbgrid', maxWireVersion: 7 },
    {}
  ]) {
    await assert.rejects(verifyDatabaseTransactionTopology(topologyDatabase(hello)), DatabaseTopologyUnavailableError);
  }
});

test('legacy hello is used only for CommandNotFound and errors never expose server details', async () => {
  const commands: Document[] = [];
  const db = { command: async (command: Document) => {
    commands.push(command);
    if (command.hello) throw Object.assign(new Error('synthetic'), { code: 59 });
    return { ...replicaSetHello, isWritablePrimary: undefined, ismaster: true };
  } } as unknown as Db;
  await verifyDatabaseTransactionTopology(db);
  assert.deepEqual(commands, [{ hello: 1 }, { isMaster: 1 }]);
  for (const command of [() => { throw new Error('private hostname'); }, async () => { throw new Error('private hostname'); }]) {
    await assert.rejects(verifyDatabaseTransactionTopology({ command } as unknown as Db), error => {
      assert.ok(error instanceof DatabaseTopologyUnavailableError);
      assert.equal(String(error).includes('private hostname'), false);
      return true;
    });
  }
});

test('startup rejects standalone before indexes and closes the unpublished client', async t => {
  const originalUri = process.env.DB_CONN_STRING;
  const originalName = process.env.DB_NAME;
  process.env.DB_CONN_STRING = 'mongodb://127.0.0.1:1';
  process.env.DB_NAME = 'synthetic';
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  let closed = 0;
  const db = topologyDatabase({ isWritablePrimary: true, maxWireVersion: 25 });
  t.mock.method(MongoClient.prototype, 'connect', async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, 'db', () => db);
  t.mock.method(MongoClient.prototype, 'close', async () => { closed++; });
  try {
    await assert.rejects(connectToDatabase(), DatabaseTopologyUnavailableError);
    assert.equal(closed, 1);
    assert.equal(getDb(), null);
    assert.throws(getDatabaseClient, /not connected/);
    assert.equal(await checkDatabaseReadiness(), false);
  } finally {
    if (originalUri === undefined) delete process.env.DB_CONN_STRING; else process.env.DB_CONN_STRING = originalUri;
    if (originalName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = originalName;
  }
});

test('cached readiness rechecks topology after expiry and recovers without new index writes', async t => {
  const originalUri = process.env.DB_CONN_STRING;
  const originalName = process.env.DB_NAME;
  process.env.DB_CONN_STRING = 'mongodb://127.0.0.1:1';
  process.env.DB_NAME = 'synthetic';
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  let now = 1_000;
  let hello: Document = replicaSetHello;
  let writes = 0;
  t.mock.method(Date, 'now', () => now);
  const db = {
    command: async () => hello,
    createCollection: async () => { writes++; },
    collection: (name: string) => ({
      createIndex: async () => { writes++; },
      updateOne: async () => { writes++; },
      listIndexes: () => ({ toArray: async () => databaseIndexes.filter(index => index.collection === name)
        .map(index => ({ key: index.keys, unique: index.options?.unique })) })
    })
  } as unknown as Db;
  t.mock.method(MongoClient.prototype, 'connect', async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, 'db', () => db);
  t.mock.method(MongoClient.prototype, 'close', async () => undefined);
  try {
    await connectToDatabase();
    const startupWrites = writes;
    hello = { ...replicaSetHello, setName: undefined };
    assert.equal(await checkDatabaseReadiness(), true);
    now += 30_001;
    assert.equal(await checkDatabaseReadiness(), false);
    hello = replicaSetHello;
    assert.equal(await checkDatabaseReadiness(), true);
    assert.equal(writes, startupWrites);
  } finally {
    await disconnectFromDatabase();
    if (originalUri === undefined) delete process.env.DB_CONN_STRING; else process.env.DB_CONN_STRING = originalUri;
    if (originalName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = originalName;
  }
});

test('receipt collection permission failure closes the unpublished client and leaves readiness false', async t => {
  const originalUri = process.env.DB_CONN_STRING;
  const originalName = process.env.DB_NAME;
  process.env.DB_CONN_STRING = 'mongodb://127.0.0.1:1';
  process.env.DB_NAME = 'synthetic';
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  let closed = 0;
  const db = {
    ...topologyDatabase(replicaSetHello),
    createCollection: async () => { throw Object.assign(new Error('private permission detail'), { code: 13 }); }
  } as unknown as Db;
  t.mock.method(MongoClient.prototype, 'connect', async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, 'db', () => db);
  t.mock.method(MongoClient.prototype, 'close', async () => { closed++; });
  try {
    await assert.rejects(connectToDatabase(), DatabaseCollectionInitializationError);
    assert.equal(closed, 1);
    assert.equal(getDb(), null);
    assert.throws(getDatabaseClient, /not connected/);
    assert.equal(await checkDatabaseReadiness(), false);
  } finally {
    if (originalUri === undefined) delete process.env.DB_CONN_STRING; else process.env.DB_CONN_STRING = originalUri;
    if (originalName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = originalName;
  }
});
