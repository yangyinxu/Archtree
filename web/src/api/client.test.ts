import { z } from 'zod';

import { apiRequest } from './client';
import { browserSessionSchema } from './schemas';

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

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const waitForCondition = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
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
    return accessCookieIsCurrent ? jsonResponse({ ready: true }) : jsonResponse({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);

  const responseSchema = z.object({ ready: z.boolean() }).strict();
  const first = apiRequest('/content/protected-one', responseSchema);
  const second = apiRequest('/content/protected-two', responseSchema);
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
  await expect(apiRequest('/content/protected', responseSchema)).resolves.toEqual({ ready: true });
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

  const firstRequest = firstTab.apiRequest('/content/first-tab', responseSchema);
  const secondRequest = secondTab.apiRequest('/content/second-tab', responseSchema);
  await waitForCondition(
    () => lockRequest.mock.calls.length === 2
      && fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh').length === 1,
    'The second tab did not wait behind the first tab refresh.'
  );
  releaseRefresh();

  await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
    { ready: true },
    { ready: true }
  ]);
  expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
    'finitude:browser-session-refresh',
    'finitude:browser-session-refresh'
  ]);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  expect(sessionChecks).toBe(2);
  expect(expiredAccessAttempts).toBe(2);
  expect(currentAccessAttempts).toBe(2);
});
