import { z } from 'zod';

import { apiRequest } from './client';
import { captureAccountOperation, isAccountOperationCurrent } from './accountEpoch';
import { browserSessionSchema } from './schemas';
import {
  flushListenerTelemetry,
  resetListenerTelemetryForTests
} from '../telemetry/client';
import { subscribeToAccountSessionChanges } from './accountSessionEvents';

const sessionBody = {
  user: {
    id: 'listener-1',
    email: 'listener@example.com',
    role: 'user',
    displayName: 'Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
};

const jsonResponse = (body: unknown, status = 200, viewer: string | undefined = 'listener-1') => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (viewer) headers.set('X-Finitude-Account-Viewer', viewer);
  return new Response(JSON.stringify(body), { status, headers });
};

const waitForCondition = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  throw new Error(message);
};

test('strict session schema rejects a credential leak', () => {
  expect(browserSessionSchema.safeParse({
    ...sessionBody,
    accessToken: 'must-not-reach-the-browser'
  }).success).toBe(false);
});

test('coalesces concurrent 401 responses into one cookie refresh', async () => {
  let accessCookieIsCurrent = false;
  let sessionChecks = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path === '/auth/browser/session') {
      sessionChecks += 1;
      return accessCookieIsCurrent ? jsonResponse(sessionBody) : jsonResponse({}, 401);
    }
    if (path === '/auth/browser/refresh') {
      await refreshGate;
      accessCookieIsCurrent = true;
      return jsonResponse(sessionBody);
    }
    return accessCookieIsCurrent ? jsonResponse({ ready: true }) : jsonResponse({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);

  const responseSchema = z.object({ ready: z.boolean() }).strict();
  const first = apiRequest('/content/protected-one', responseSchema, { accountViewer: 'listener-1' });
  const second = apiRequest('/content/protected-two', responseSchema, { accountViewer: 'listener-1' });
  await waitForCondition(
    () => fetchMock.mock.calls.some(([path]) => path === '/auth/browser/refresh'),
    'Refresh request did not start.'
  );
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  releaseRefresh();

  await expect(Promise.all([first, second])).resolves.toEqual([{ ready: true }, { ready: true }]);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  expect(sessionChecks).toBe(1);
});

test('accepts a current session when refresh reports that the old cookie was consumed', async () => {
  let protectedCalls = 0;
  let sessionChecks = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/auth/browser/session') {
      sessionChecks += 1;
      return sessionChecks === 1 ? jsonResponse({}, 401) : jsonResponse(sessionBody);
    }
    if (path === '/auth/browser/refresh') return jsonResponse({}, 401);
    protectedCalls += 1;
    return protectedCalls === 1 ? jsonResponse({}, 401) : jsonResponse({ ready: true });
  });
  vi.stubGlobal('fetch', fetchMock);

  const responseSchema = z.object({ ready: z.boolean() }).strict();
  await expect(apiRequest('/content/protected', responseSchema, {
    accountViewer: 'listener-1'
  })).resolves.toEqual({ ready: true });
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  expect(sessionChecks).toBe(2);
});

test('waits for another tab and reuses its newly rotated access cookie', async () => {
  let lockTail: Promise<unknown> = Promise.resolve();
  const lockRequest = vi.fn((
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<unknown>
  ) => {
    const result = lockTail.then(callback);
    lockTail = result.then(() => undefined, () => undefined);
    return result;
  });
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });

  let accessCookieIsCurrent = false;
  let sessionChecks = 0;
  let expiredAccessAttempts = 0;
  let currentAccessAttempts = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/auth/browser/session') {
      sessionChecks += 1;
      return accessCookieIsCurrent ? jsonResponse(sessionBody) : jsonResponse({}, 401);
    }
    if (path === '/auth/browser/refresh') {
      await refreshGate;
      accessCookieIsCurrent = true;
      return jsonResponse(sessionBody);
    }
    if (accessCookieIsCurrent) {
      currentAccessAttempts += 1;
      return jsonResponse({ ready: true });
    }
    expiredAccessAttempts += 1;
    return jsonResponse({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  const firstTab = await import('./client');
  vi.resetModules();
  const secondTab = await import('./client');
  const responseSchema = z.object({ ready: z.boolean() }).strict();

  const firstRequest = firstTab.apiRequest('/content/first-tab', responseSchema, {
    accountViewer: 'listener-1'
  });
  const secondRequest = secondTab.apiRequest('/content/second-tab', responseSchema, {
    accountViewer: 'listener-1'
  });
  await waitForCondition(
    () => lockRequest.mock.calls.length === 1
      && fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh').length === 1,
    'The second tab did not wait behind the first tab refresh.'
  );
  releaseRefresh();

  await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
    { ready: true },
    { ready: true }
  ]);
  expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
    'finitude:browser-session-transition',
    'finitude:browser-session-transition'
  ]);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  expect(sessionChecks).toBe(2);
  expect(expiredAccessAttempts).toBe(2);
  expect(currentAccessAttempts).toBe(2);
});

test('reports a terminal listener API failure using only bounded classifications', async () => {
  resetListenerTelemetryForTests();
  window.history.replaceState({}, '', '/finitude/albums/private-content-id');
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === '/api/listener/v1/telemetry') {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ message: 'private upstream error text' }, 503);
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(apiRequest(
    '/api/listener/v1/home?query=private-search',
    z.object({ ready: z.boolean() }).strict(),
    { retryAuthentication: false }
  )).rejects.toMatchObject({ status: 503 });
  flushListenerTelemetry();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const telemetryInit = fetchMock.mock.calls[1][1] as RequestInit;
  expect(JSON.parse(String(telemetryInit.body))).toEqual({ events: [{
    category: 'api_error',
    operation: 'listener_home',
    kind: 'http',
    statusBucket: '5xx',
    route: 'album',
    attempt: 'initial'
  }] });
  expect(String(telemetryInit.body)).not.toContain('private');
  resetListenerTelemetryForTests();
});

test('rejects a private response that is not echoed for its cache viewer', async () => {
  const changes: string[] = [];
  const unsubscribe = subscribeToAccountSessionChanges((event) => changes.push(event.reason));
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ready: true }, 200, undefined));
  vi.stubGlobal('fetch', fetchMock);

  await expect(apiRequest(
    '/content/private',
    z.object({ ready: z.boolean() }).strict(),
    { accountViewer: 'viewer-a' }
  )).rejects.toMatchObject({
    status: 409,
    code: 'account_viewer_mismatch'
  });

  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(
    'X-Finitude-Account-Viewer'
  )).toBe('viewer-a');
  expect(changes).toContain('viewer-mismatch');
  unsubscribe();
});

test('recovers an expired access A plus refresh B without retrying into A caches', async () => {
  const priorGuard = captureAccountOperation('viewer-a');
  const changes: string[] = [];
  const unsubscribe = subscribeToAccountSessionChanges((event) => changes.push(event.reason));
  let protectedCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/content/private-a') {
      protectedCalls += 1;
      return jsonResponse({}, 401, undefined);
    }
    if (path === '/auth/browser/session') return jsonResponse({}, 401, undefined);
    if (path === '/auth/browser/refresh') {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Finitude-Account-Viewer')).toBe('viewer-a');
      expect(headers.get('X-Finitude-Session-Transition')).toBe('web-locks-v1');
      return jsonResponse({
        code: 'browser_session_identity_conflict',
        message: 'Conflicting credentials.'
      }, 409, undefined);
    }
    if (path === '/auth/browser/logout') {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Finitude-Session-Transition')).toBe('web-locks-v1');
      expect(headers.has('X-Finitude-Account-Viewer')).toBe(false);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(apiRequest(
    '/content/private-a',
    z.object({ ready: z.boolean() }).strict(),
    { accountViewer: 'viewer-a' }
  )).rejects.toMatchObject({ status: 401 });

  expect(protectedCalls).toBe(1);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/logout')).toHaveLength(1);
  expect(isAccountOperationCurrent(priorGuard)).toBe(false);
  expect(changes).toEqual(['logout']);
  unsubscribe();
});
