import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { installShutdownHandlers, ServerLifecycle } from '../src/services/serverLifecycleService';
import { asyncHandler } from '../src/middleware/requestProtectionMiddleware';
import { requireAuth } from '../src/middleware/authMiddleware';

/** Starts an isolated loopback server; it never uses application database configuration. */
const listen = async (app: ReturnType<typeof express>) => {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

test('drain stops admission while an existing upload and transaction finish before database close', async () => {
  const lifecycle = new ServerLifecycle();
  const app = express();
  app.use(lifecycle.admit);
  let complete!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  app.post('/upload', async (_req, res) => {
    _req.resume();
    entered();
    await new Promise<void>(resolve => { complete = resolve; });
    events.push('transaction-committed');
    res.end('published');
  });
  const { server, url } = await listen(app);
  const response = fetch(`${url}/upload`, { method: 'POST', body: 'bytes' }).then(res => res.text());
  await started;
  const stopped = lifecycle.stop(server, async () => { events.push('database-closed'); }, 1_000, 100);
  assert.equal(lifecycle.draining, true);
  assert.deepEqual(events, []);
  complete();
  assert.equal(await response, 'published');
  assert.equal(await stopped, 'graceful');
  assert.deepEqual(events, ['transaction-committed', 'database-closed']);
  assert.equal(await lifecycle.stop(server, async () => { throw new Error(); }, 1, 1), 'graceful');
});

test('streaming connections are aborted at the deadline and do not prevent cleanup', async () => {
  const lifecycle = new ServerLifecycle();
  const app = express();
  let sourceClosed = false;
  let closed!: () => void;
  const sourceFinished = new Promise<void>(resolve => { closed = resolve; });
  app.get('/stream', (_req, res) => {
    res.write('media');
    res.on('close', () => { sourceClosed = true; closed(); });
  });
  const { server, url } = await listen(app);
  const connected = new Promise<void>(resolve => {
    const req = request(`${url}/stream`, res => {
      res.on('error', () => undefined);
      res.resume();
      resolve();
    });
    req.on('error', () => undefined);
    req.end();
  });
  await connected;
  let databaseClosed = false;
  const outcome = await lifecycle.stop(server, async () => { databaseClosed = true; }, 25, 100);
  await sourceFinished;
  assert.equal(outcome, 'forced');
  assert.equal(databaseClosed, true);
  assert.equal(sourceClosed, true);
});

test('a hung database cleanup has a separate deadline', async () => {
  const { server } = await listen(express());
  const lifecycle = new ServerLifecycle();
  const started = Date.now();
  const outcome = await lifecycle.stop(server, () => new Promise(() => undefined), 50, 25);
  assert.equal(outcome, 'forced');
  assert.ok(Date.now() - started < 1_000);
});

test('admission rejects new requests when draining without invoking mutations', async () => {
  const lifecycle = new ServerLifecycle();
  lifecycle.draining = true;
  const app = express();
  app.use(lifecycle.admit);
  app.post('/mutate', () => { assert.fail('mutation must not run'); });
  const { server, url } = await listen(app);
  try {
    const response = await fetch(`${url}/mutate`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    await response.text();
  } finally { server.closeAllConnections(); server.close(); }
});

test('repeated termination signals retain the handler until one cleanup completes', async () => {
  const { server } = await listen(express());
  const lifecycle = new ServerLifecycle();
  let complete!: () => void;
  let stopped!: () => void;
  let cleanups = 0;
  const cleanup = new Promise<void>(resolve => { complete = resolve; });
  const finished = new Promise<void>(resolve => { stopped = resolve; });
  const before = process.listenerCount('SIGTERM');
  const dispose = installShutdownHandlers(server, lifecycle, async () => {
    cleanups++;
    await cleanup;
  }, 100, 500, () => stopped());
  try {
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    complete();
    await finished;
    assert.equal(cleanups, 1);
    assert.equal(process.listenerCount('SIGTERM'), before);
  } finally { complete(); dispose(); server.closeAllConnections(); server.close(); }
});

test('a disconnected mutation must finish before database cleanup can report graceful', async () => {
  for (const finishWithinGrace of [true, false]) {
    const lifecycle = new ServerLifecycle();
    const app = express();
    app.use(lifecycle.admit);
    let entered!: () => void;
    let finish!: () => void;
    let mutationPending = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mutation = new Promise<void>(resolve => { finish = resolve; });
    app.post('/mutation', asyncHandler(async (req, res) => {
      req.resume();
      entered();
      await mutation;
      mutationPending = false;
      res.end();
    }));
    const { server, url } = await listen(app);
    const req = request(`${url}/mutation`, { method: 'POST' });
    req.on('error', () => undefined);
    req.end();
    await started;
    const disconnected = new Promise<void>(resolve => req.once('close', resolve));
    req.destroy();
    await disconnected;
    let closed = false;
    const stopping = lifecycle.stop(server, async () => {
      closed = true;
      if (finishWithinGrace) assert.equal(mutationPending, false);
    }, 50, 50);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closed, false);
    if (finishWithinGrace) finish();
    assert.equal(await stopping, finishWithinGrace ? 'graceful' : 'forced');
    assert.equal(closed, true);
    finish();
    await mutation;
  }
});

test('a late parser callback cannot start new business work after database teardown', async () => {
  const lifecycle = new ServerLifecycle();
  const app = express();
  app.use(lifecycle.admit);
  let entered!: () => void;
  let lateNext!: () => void;
  const parsed = new Promise<void>(resolve => { entered = resolve; });
  let controllerStarted = false;
  app.post('/upload', (_req, _res, next) => {
    lateNext = next;
    entered();
  }, asyncHandler(async (_req, res) => { controllerStarted = true; res.end(); }));
  app.use((_error: Error, _req: express.Request, _res: express.Response, _next: express.NextFunction) => undefined);
  const { server, url } = await listen(app);
  const req = request(`${url}/upload`, { method: 'POST' });
  req.on('error', () => undefined);
  req.end();
  await parsed;
  const disconnected = new Promise<void>(resolve => req.once('close', resolve));
  req.destroy();
  await disconnected;
  await lifecycle.stop(server, async () => undefined, 100, 100);
  lateNext();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controllerStarted, false);
});

test('late authentication work reaches the Express error boundary after teardown', async () => {
  const lifecycle = new ServerLifecycle();
  const app = express();
  app.use(lifecycle.admit);
  let entered!: () => void;
  let lateNext!: () => void;
  let failed!: () => void;
  const parsed = new Promise<void>(resolve => { entered = resolve; });
  const errorSeen = new Promise<void>(resolve => { failed = resolve; });
  app.get('/protected', (_req, _res, next) => { lateNext = next; entered(); }, requireAuth);
  app.use((error: { statusCode: number }, _req: express.Request, _res: express.Response, _next: express.NextFunction) => {
    assert.equal(error.statusCode, 503);
    failed();
  });
  const { server, url } = await listen(app);
  const req = request(`${url}/protected`);
  req.on('error', () => undefined);
  req.end();
  await parsed;
  const disconnected = new Promise<void>(resolve => req.once('close', resolve));
  req.destroy();
  await disconnected;
  await lifecycle.stop(server, async () => undefined, 100, 100);
  lateNext();
  await errorSeen;
});
