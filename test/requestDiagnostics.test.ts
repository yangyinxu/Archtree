import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRequestDiagnostics, safeServerErrorCategory } from '../src/middleware/requestDiagnosticsMiddleware';
import { createRuntimeResourceReader } from '../src/services/runtimeResourcesService';

test('request diagnostics replace caller identifiers and retain only fixed categories', async () => {
  const diagnostics = createRequestDiagnostics();
  const app = express();
  app.use(diagnostics.observe);
  app.get('/content/private-title', (_req, res) => res.status(503).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/content/private-title?email=private`, {
      headers: { 'X-Request-Id': 'private-user-value' }
    });
    assert.match(response.headers.get('X-Request-Id')!, /^[a-f0-9-]{36}$/);
    await response.text();
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.byArea.content.active, 0);
    assert.equal(snapshot.byArea.content.failed, 1);
    assert.equal(snapshot.byArea.content.completed, 1);
    assert.equal(snapshot.byArea.content.durationBuckets.reduce((a, b) => a + b), 1);
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
    assert.equal(snapshot.scope, 'process');
    snapshot.byArea.content.completed = 900;
    assert.equal(diagnostics.snapshot().byArea.content.completed, 1);
  } finally { server.closeAllConnections(); server.close(); }
});

test('error classification never returns arbitrary exception text or class names', () => {
  assert.equal(safeServerErrorCategory({ name: 'MongoServerError', message: 'secret' }), 'database');
  assert.equal(safeServerErrorCategory({ name: 'private value', code: 'credential' }), 'internal');
  assert.equal(safeServerErrorCategory(null), 'internal');
});

test('temporary-storage diagnostics coalesce readers, cache results, and report unknown on failure', async () => {
  let calls = 0;
  let now = 0;
  const read = createRuntimeResourceReader(async () => {
    calls++;
    if (calls > 1) throw new Error('private filesystem path');
    return { type: 0, bsize: 10, blocks: 100, bfree: 30, bavail: 20, files: 0, ffree: 0 };
  }, () => now);
  const results = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0].temporaryStorage, { availableBytes: 200, totalBytes: 1_000 });
  assert.equal(JSON.stringify(results[0]).includes('private'), false);
  now = 30_001;
  assert.equal((await read()).temporaryStorage, null);
});
