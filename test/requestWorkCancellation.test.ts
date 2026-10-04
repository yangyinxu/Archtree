import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import test, { type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import express, { type Request, type Response } from 'express';
import { createApp, handleApplicationError } from '../src/app';
import AuthSession from '../src/models/authSession';
import User from '../src/models/user';
import { runRequestWork, ServerLifecycle } from '../src/services/serverLifecycleService';
import { createRequestDiagnostics } from '../src/middleware/requestDiagnosticsMiddleware';
import { asyncHandler } from '../src/middleware/requestProtectionMiddleware';
import { createRoomRouter } from '../src/routes/roomRoutes';
import { createSocialRouter } from '../src/routes/socialRoutes';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import type { RoomApi } from '../src/contracts/roomV1';
import { SocialError, type SocialApi } from '../src/contracts/socialV1';

/** Exercises the production error boundary on real sockets, with no database or external service. */
const listenForFailure = async (
  t: TestContext,
  environment: 'production' | 'develop',
  handler: (req: Request, res: Response) => Promise<unknown>,
  router?: 'room' | 'social'
) => {
  const app = express();
  app.set('env', environment);
  app.set('trust proxy', 1);
  const lifecycle = new ServerLifecycle();
  const logs: string[] = [];
  let forwardedErrors = 0;
  let jsonWrites = 0;
  let statusWrites = 0;
  t.mock.method(console, 'error', (...values: unknown[]) => { logs.push(values.map(String).join('\n')); });
  app.use(createRequestDiagnostics().observe, lifecycle.admit);
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    const status = res.status.bind(res);
    res.json = body => { jsonWrites++; return json(body); };
    res.status = code => { statusWrites++; return status(code); };
    next();
  });
  if (router) {
    // The injected service runs under its original request while the real router owns dispatch and error DTOs.
    const context = new AsyncLocalStorage<{ req: Request; res: Response }>();
    app.use((req, res, next) => {
      (req as AuthenticatedRequest).auth = { userId: 'synthetic-account', sessionId: 'synthetic-session',
        email: 'fixture@example.test', role: 'user' };
      context.run({ req, res }, next);
    });
    const fail = async () => {
      const request = context.getStore();
      assert.ok(request);
      await handler(request.req, request.res);
    };
    app.use('/api/social/v1', router === 'room'
      ? createRoomRouter({ currentRoom: async () => { await fail(); return null; } } as unknown as RoomApi)
      : createSocialRouter({ api: { ownListening: async () => {
        await fail(); return { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: 1 };
      } } as unknown as SocialApi }));
  } else {
    app.get('/content/private-title', asyncHandler(handler));
  }
  app.use(handleApplicationError);
  app.use((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    forwardedErrors++;
    next(error);
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    server, lifecycle, logs, counts: () => ({ forwardedErrors, jsonWrites }), statusWrites: () => statusWrites,
    headers: { Authorization: 'Bearer synthetic', 'X-Finitude-Room-Client': 'synthetic-room-client-001',
      'X-Forwarded-Proto': 'https' },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${router
      ? `/api/social/v1/${router === 'room' ? 'rooms/current' : 'me/listening'}`
      : '/content/private-title?query=private-query'}`
  };
};

/** Synthetic private fields must never reach logs, a public 5xx body, or Express's raw-error logger. */
const privateFailure = (statusCode: unknown = 503) => Object.assign(
  new Error('private-title@example.test token-sentinel object-key-sentinel'),
  { name: 'PrivateServiceException', statusCode, data: { payload: 'private-payload-sentinel' } }
);

const assertSafeDiagnostic = (logged: string, status: number, requestArea = 'content') => {
  assert.doesNotMatch(logged, /private|sentinel|example|ServiceException|stack/);
  const record = JSON.parse(logged);
  assert.deepEqual(Object.keys(record).sort(),
    ['category', 'errorCategory', 'requestId', 'method', 'occurredAt', 'requestArea', 'status'].sort());
  assert.equal(record.category, 'server_error');
  assert.equal(record.errorCategory, 'internal');
  assert.equal(record.requestArea, requestArea);
  assert.equal(record.method, 'GET');
  assert.equal(record.status, status);
  assert.match(record.requestId, /^[a-f0-9-]{36}$/);
};

for (const environment of ['production', 'develop'] as const) {
  test(`${environment}: a partial-body failure logs safely and closes without another write or raw forwarding`, async t => {
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { received = resolve; });
    const fixture = await listenForFailure(t, environment, async (_req, res) => {
      res.type('text/plain').write('prefix');
      await gate;
      throw privateFailure();
    });
    const chunks: string[] = [];
    let status: number | undefined;
    let aborted = false;
    const closed = new Promise<void>(resolve => {
      const req = request(fixture.url, response => {
        status = response.statusCode;
        response.on('data', chunk => { chunks.push(String(chunk)); received(); });
        response.on('aborted', () => { aborted = true; });
        response.on('error', () => undefined);
        response.once('close', resolve);
      });
      req.on('error', () => undefined);
      req.end();
    });
    try {
      await started;
      let databaseClosed = false;
      const stopping = fixture.lifecycle.stop(fixture.server, async () => { databaseClosed = true; }, 1_000, 100);
      assert.equal(databaseClosed, false);
      release();
      await closed;
      assert.equal(await stopping, 'graceful');
      assert.equal(databaseClosed, true);
      assert.equal(status, 200);
      assert.equal(aborted, true);
      assert.equal(chunks.join(''), 'prefix');
      assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 0 });
      assert.equal(fixture.logs.length, 1);
      assertSafeDiagnostic(fixture.logs[0], 503);
    } finally { release(); }
  });

  test(`${environment}: a genuine 503 after a completed response remains visible without a second JSON response`, async t => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await listenForFailure(t, environment, async (_req, res) => {
      res.end('completed');
      await gate;
      throw privateFailure();
    });
    try {
      const response = await fetch(fixture.url);
      assert.equal(await response.text(), 'completed');
      let databaseClosed = false;
      const stopping = fixture.lifecycle.stop(fixture.server, async () => { databaseClosed = true; }, 1_000, 100);
      assert.equal(databaseClosed, false);
      release();
      assert.equal(await stopping, 'graceful');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(databaseClosed, true);
      assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 0 });
      assert.equal(fixture.logs.length, 1);
      assertSafeDiagnostic(fixture.logs[0], 503);
    } finally { release(); }
  });

  test(`${environment}: a genuine disconnected-handler 503 is logged while pending work still drains`, async t => {
    let release!: () => void;
    let entered!: () => void;
    let responseClosed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    const fixture = await listenForFailure(t, environment, async (_req, res) => {
      res.once('close', responseClosed);
      entered();
      await gate;
      throw privateFailure();
    });
    const req = request(fixture.url);
    req.on('error', () => undefined);
    req.end();
    try {
      await started;
      req.destroy();
      await closed;
      let databaseClosed = false;
      const stopping = fixture.lifecycle.stop(fixture.server, async () => { databaseClosed = true; }, 1_000, 100);
      assert.equal(databaseClosed, false);
      release();
      assert.equal(await stopping, 'graceful');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(databaseClosed, true);
      assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 0 });
      assert.equal(fixture.logs.length, 1);
      assertSafeDiagnostic(fixture.logs[0], 503);
    } finally { release(); req.destroy(); }
  });

  test(`${environment}: only the internal completed-request dispatch cancellation remains silent`, async t => {
    let controllerStarted = false;
    const fixture = await listenForFailure(t, environment, async (req, res) => {
      const finished = new Promise<void>(resolve => res.once('finish', resolve));
      res.end('completed');
      await finished;
      await runRequestWork(req, () => { controllerStarted = true; });
    });
    assert.equal(await (await fetch(fixture.url)).text(), 'completed');
    assert.equal(await fixture.lifecycle.stop(fixture.server, async () => undefined, 1_000, 100), 'graceful');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(controllerStarted, false);
    assert.deepEqual(fixture.logs, []);
    assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 0 });
  });

  test(`${environment}: live 503 and invalid statuses preserve generic public errors and bounded diagnostics`, async t => {
    const statuses: unknown[] = [503, 200, 0, 600, NaN, Infinity, 503.5, '503', null];
    let index = 0;
    const fixture = await listenForFailure(t, environment, async () => { throw privateFailure(statuses[index++]); });
    for (const [position, candidate] of statuses.entries()) {
      const expected = candidate === 503 ? 503 : 500;
      const response = await fetch(fixture.url);
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), { message: 'The service could not complete the request.' });
      assertSafeDiagnostic(fixture.logs[position], expected);
    }
    assert.equal(fixture.logs.length, statuses.length);
    assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: statuses.length });
  });
}

for (const router of ['room', 'social'] as const) {
  for (const completion of ['disconnected', 'completed'] as const) {
    for (const failure of ['known 503', 'internal cancellation'] as const) {
      test(`${router}: ${failure} after a ${completion} response uses the shared safe boundary without another write`, async t => {
        let release!: () => void;
        let entered!: () => void;
        let responseClosed!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const closed = new Promise<void>(resolve => { responseClosed = resolve; });
        let lateDispatchStarted = false;
        const fixture = await listenForFailure(t, 'production', async (req, res) => {
          res.once('close', responseClosed);
          if (completion === 'completed') res.end('completed');
          entered();
          await gate;
          assert.equal(res.headersSent, completion === 'completed');
          assert.equal(res.destroyed || res.writableEnded, true);
          if (failure === 'internal cancellation') {
            await runRequestWork(req, () => { lateDispatchStarted = true; });
          } else {
            throw Object.assign(new SocialError(503, `${router}_unavailable`), {
              message: 'private-title@example.test token-sentinel object-key-sentinel',
              data: { payload: 'private-payload-sentinel' }
            });
          }
        }, router);
        const clientResponse = new Promise<string>(resolve => {
          const req = request(fixture.url, { headers: fixture.headers }, res => {
            let body = '';
            res.on('data', chunk => { body += String(chunk); });
            res.once('end', () => resolve(body));
          });
          req.on('error', () => resolve(''));
          req.end();
          void started.then(() => { if (completion === 'disconnected') req.destroy(); });
          t.after(() => req.destroy());
        });
        try {
          await started;
          assert.equal(await clientResponse, completion === 'completed' ? 'completed' : '');
          await closed;
          let databaseClosed = false;
          const stopping = fixture.lifecycle.stop(fixture.server, async () => { databaseClosed = true; }, 1_000, 100);
          assert.equal(databaseClosed, false);
          release();
          assert.equal(await stopping, 'graceful');
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(databaseClosed, true);
          assert.equal(lateDispatchStarted, false);
          assert.equal(fixture.statusWrites(), 0);
          assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 0 });
          assert.equal(fixture.logs.length, failure === 'known 503' ? 1 : 0);
          if (failure === 'known 503') assertSafeDiagnostic(fixture.logs[0], 503, 'other');
        } finally { release(); }
      });
    }
  }

  test(`${router}: live known errors retain their existing status, code and message DTO`, async t => {
    const codes = [`${router}_unavailable`, 'invalid_request'];
    let index = 0;
    const fixture = await listenForFailure(t, 'production', async () => {
      const position = index++;
      throw new SocialError(position === 0 ? 503 : 400, codes[position]);
    }, router);
    for (const [position, code] of codes.entries()) {
      const response = await fetch(fixture.url, { headers: fixture.headers });
      assert.equal(response.status, position === 0 ? 503 : 400);
      assert.deepEqual(await response.json(), { code, message: 'The social request could not be completed.' });
      assert.match(response.headers.get('cache-control')!, /no-store/);
    }
    assert.equal(fixture.statusWrites(), 2);
    assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 2 });
    assert.deepEqual(fixture.logs, []);
  });
}

test('known live 4xx messages and validation data retain their existing response contract', async t => {
  const fixture = await listenForFailure(t, 'production', async () => {
    throw Object.assign(new Error('Validation failed.'), { statusCode: 422, data: { field: 'title' } });
  });
  const response = await fetch(fixture.url);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { message: 'Validation failed.', data: { field: 'title' } });
  assert.deepEqual(fixture.logs, []);
  assert.deepEqual(fixture.counts(), { forwardedErrors: 0, jsonWrites: 1 });
});

test('late database-backed authentication after page departure never dispatches the controller or logs a false 503', async t => {
  const previousSecret = process.env.JWT_SECRET;
  const jwtSecret = 'request-cancellation-unit-test-secret';
  process.env.JWT_SECRET = jwtSecret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  let entered!: () => void;
  let release!: () => void;
  let responseClosed!: () => void;
  const authenticating = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const closed = new Promise<void>(resolve => { responseClosed = resolve; });
  let userReads = 0;
  t.mock.method(AuthSession, 'findActiveById', async () => {
    entered();
    await gate;
    return { userId: 'cancellation-test-viewer' };
  });
  t.mock.method(User, 'findById', async () => {
    userReads++;
    if (userReads > 1) throw new Error('The departed request dispatched its controller.');
    return { email: 'fixture@example.test', role: 'user' };
  });
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: unknown) => { logs.push(String(value)); });
  const lifecycle = new ServerLifecycle();
  const app = createApp({ environment: 'test', lifecycle });
  const server = createServer((req, res) => {
    res.once('close', responseClosed);
    app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const token = jwt.sign({
    userId: 'cancellation-test-viewer', email: 'fixture@example.test',
    sessionId: 'cancellation-test-session', tokenType: 'access'
  }, jwtSecret, { algorithm: 'HS256', expiresIn: 60 });
  const req = request(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  req.on('error', () => undefined);
  req.end();
  try {
    await authenticating;
    req.destroy();
    await closed;
    let databaseClosed = false;
    const stopping = lifecycle.stop(server, async () => { databaseClosed = true; }, 1_000, 100);
    assert.equal(databaseClosed, false);
    release();
    assert.equal(await stopping, 'graceful');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(userReads, 1);
    assert.equal(databaseClosed, true);
    assert.deepEqual(logs, []);
  } finally { release(); req.destroy(); server.closeAllConnections(); server.close(); }
});

test('a live unavailable-artifact request retains its real 503 and bounded server diagnostic', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'archtree-request-work-'));
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: unknown) => { logs.push(String(value)); });
  const server = createServer(createApp({
    environment: 'test', localizationDistPath: path.join(temporaryRoot, 'missing-localizations')
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/localizations/v1/manifest`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { message: 'The service could not complete the request.' });
    assert.equal(logs.length, 1);
    const record = JSON.parse(logs[0]);
    assert.equal(record.category, 'server_error');
    assert.equal(record.status, 503);
    assert.equal(record.errorCategory, 'internal');
    assert.match(record.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(record).sort(),
      ['category', 'errorCategory', 'requestId', 'method', 'occurredAt', 'requestArea', 'status'].sort());
    assert.equal(logs[0].includes(temporaryRoot), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
