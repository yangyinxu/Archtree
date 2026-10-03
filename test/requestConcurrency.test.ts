import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { asyncHandler, limitConcurrency } from '../src/middleware/requestProtectionMiddleware';
import { onRequestWorkComplete, runRequestWork, ServerLifecycle } from '../src/services/serverLifecycleService';

/** Holds only synthetic work so abort tests cannot affect external resources. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

for (const [name, perClientLimit, globalLimit, capacity] of [
  ['per-client', 2, 8, 2],
  ['process', 50, 8, 8]
] as const) {
  test(`${name} work capacity remains occupied after every client disconnects`, { timeout: 10_000 }, async () => {
    const controls = Array.from({ length: capacity + 1 }, () => ({
      entered: deferred(), release: deferred(), closed: deferred(), settled: deferred()
    }));
    const app = express();
    app.use(new ServerLifecycle().admit);
    let active = 0;
    let peak = 0;
    app.get('/work', limitConcurrency(`disconnected-${name}`, perClientLimit, globalLimit), asyncHandler(async (req, res) => {
      const control = controls[Number(req.query.slot)];
      active += 1;
      peak = Math.max(peak, active);
      res.once('close', control.closed.resolve);
      control.entered.resolve();
      await control.release.promise;
      active -= 1;
      if (!res.destroyed) res.end('complete');
      control.settled.resolve();
    }));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/work`;
    try {
      for (let slot = 0; slot < capacity; slot++) {
        const client = request(`${url}?slot=${slot}`);
        client.on('error', () => undefined);
        client.end();
        await controls[slot].entered.promise;
        client.destroy();
        await controls[slot].closed.promise;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const blocked = await fetch(`${url}?slot=${capacity}`);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get('retry-after'), '2');
        await blocked.text();
      }
      assert.equal(active, capacity);
      assert.equal(peak, capacity);
      controls[0].release.resolve();
      await controls[0].settled.promise;
      await new Promise(resolve => setImmediate(resolve));
      const admitted = fetch(`${url}?slot=${capacity}`);
      await controls[capacity].entered.promise;
      controls[capacity].release.resolve();
      const response = await admitted;
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(peak, capacity);
    } finally {
      controls.forEach(control => control.release.resolve());
      await new Promise(resolve => setImmediate(resolve));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('response completion waits for all nested work, including rejection, before releasing once', async () => {
  const req = {} as express.Request;
  const res = new EventEmitter() as unknown as express.Response;
  const first = deferred();
  const second = deferred();
  let released = 0;
  onRequestWorkComplete(req, res, () => { released++; });
  const workA = runRequestWork(req, () => first.promise);
  const workB = runRequestWork(req, async () => { await second.promise; throw new Error('synthetic failure'); });
  const rejected = assert.rejects(workB, /synthetic failure/);
  await new Promise(resolve => setImmediate(resolve));
  res.emit('finish');
  res.emit('close');
  assert.equal(released, 0);
  first.resolve();
  await workA;
  assert.equal(released, 0);
  second.resolve();
  await rejected;
  assert.equal(released, 1);
  res.emit('close');
  assert.equal(released, 1);
});

test('late middleware cannot start work after its response has released capacity', async () => {
  const req = {} as express.Request;
  const res = new EventEmitter() as unknown as express.Response;
  let ran = false;
  let released = false;
  onRequestWorkComplete(req, res, () => { released = true; });
  res.emit('close');
  assert.equal(released, true);
  await assert.rejects(runRequestWork(req, () => { ran = true; }), { statusCode: 503 });
  assert.equal(ran, false);
});

test('disconnect before the admitted microtask runs skips work and releases its lease once', async () => {
  const req = {} as express.Request;
  const res = new EventEmitter() as unknown as express.Response;
  let ran = false;
  let released = 0;
  onRequestWorkComplete(req, res, () => { released++; });
  const work = runRequestWork(req, () => { ran = true; });
  res.emit('close');
  assert.equal(released, 0);
  await assert.rejects(work, { statusCode: 503 });
  assert.equal(ran, false);
  assert.equal(released, 1);
  res.emit('finish');
  assert.equal(released, 1);
});

test('a successful response does not release capacity while its handler is still completing', async () => {
  const req = { ip: 'synthetic-finish', socket: {} } as express.Request;
  const capture = () => Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: () => undefined,
    status(code: number) { this.statusCode = code; return this; },
    json: () => undefined
  }) as unknown as express.Response;
  const limit = limitConcurrency('early-success', 1, 1);
  const res = capture();
  const finish = deferred();
  limit(req, res, () => undefined);
  const work = runRequestWork(req, () => finish.promise);
  await new Promise(resolve => setImmediate(resolve));
  res.emit('finish');
  const blocked = capture();
  limit({ ip: req.ip, socket: {} } as express.Request, blocked, () => assert.fail('work is still active'));
  assert.equal(blocked.statusCode, 429);
  finish.resolve();
  await work;
  const next = capture();
  let admitted = false;
  limit({ ip: req.ip, socket: {} } as express.Request, next, () => { admitted = true; });
  assert.equal(admitted, true);
  next.emit('finish');
});
