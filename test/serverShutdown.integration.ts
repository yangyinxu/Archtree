import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import { asyncHandler, limitConcurrency } from '../src/middleware/requestProtectionMiddleware';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
before(async () => { harness = await startMongoReplicaSet('archtree-shutdown-tests'); });
after(async () => { await harness?.stop(); });

test('disconnected HTTP transaction retains capacity and commits before graceful database teardown', async () => {
  const db = getDb()!;
  await db.createCollection('shutdownFixture');
  const lifecycle = new ServerLifecycle();
  const app = express();
  app.use(lifecycle.admit);
  let finish!: () => void;
  let entered!: () => void;
  const workGate = new Promise<void>(resolve => { finish = resolve; });
  const written = new Promise<void>(resolve => { entered = resolve; });
  let cleanupStarted = false;
  app.post('/mutation', limitConcurrency('shutdown-transaction', 1, 1), asyncHandler(async (req, res) => {
    req.resume();
    const session = getDatabaseClient().startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('shutdownFixture').insertOne({ value: 'synthetic' }, { session });
        entered();
        await workGate;
      });
    } finally { await session.endSession(); }
    res.end();
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mutation`;
  const req = request(url, { method: 'POST' });
  req.on('error', () => undefined);
  req.end();
  try {
    await written;
    const closed = new Promise<void>(resolve => req.once('close', resolve));
    req.destroy();
    await closed;
    const rejected = await fetch(url, { method: 'POST' });
    assert.equal(rejected.status, 429);
    await rejected.text();
    const stopping = lifecycle.stop(server, async () => {
      cleanupStarted = true;
      assert.equal(await db.collection('shutdownFixture').countDocuments({}), 1);
    }, 2_000, 1_000);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(cleanupStarted, false);
    assert.equal(await db.collection('shutdownFixture').countDocuments({}), 0);
    finish();
    assert.equal(await stopping, 'graceful');
    assert.equal(cleanupStarted, true);
  } finally { finish(); req.destroy(); server.closeAllConnections(); server.close(); }
});
