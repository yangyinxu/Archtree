import { captureAccountOperation, isAccountOperationCurrent } from './accountEpoch';
import {
  accountSessionChangeStorageKey,
  subscribeToAccountSessionChanges
} from './accountSessionEvents';
import { getBrowserSession, loginBrowserSession } from './session';

const sessionFor = (id: string) => ({
  user: {
    id,
    email: `${id}@example.com`,
    role: 'user',
    displayName: id,
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
});

test('recovers mixed account cookies only through the Web-Locked logout path', async () => {
  const changes: string[] = [];
  const unsubscribe = subscribeToAccountSessionChanges((event) => changes.push(event.reason));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === '/auth/browser/session') {
      return new Response(JSON.stringify({
        code: 'browser_session_identity_conflict',
        message: 'Conflicting credentials.'
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(input) === '/auth/browser/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(getBrowserSession()).resolves.toBeNull();
  const logout = fetchMock.mock.calls.find(([path]) => path === '/auth/browser/logout');
  expect(logout).toBeDefined();
  const headers = new Headers(logout?.[1]?.headers);
  expect(headers.get('X-Finitude-Session-Transition')).toBe('web-locks-v1');
  expect(headers.has('X-Finitude-Account-Viewer')).toBe(false);
  expect(changes).toEqual(['logout']);
  expect(JSON.parse(window.localStorage.getItem(accountSessionChangeStorageKey) ?? '{}'))
    .toMatchObject({ reason: 'logout' });
  unsubscribe();
});

test('adopts an authoritative viewer during an unbound first-load refresh', async () => {
  const priorGuard = captureAccountOperation('viewer-a');
  const changes: string[] = [];
  const unsubscribe = subscribeToAccountSessionChanges((event) => changes.push(event.reason));
  let sessionChecks = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/auth/browser/session') {
      sessionChecks += 1;
      return sessionChecks < 3
        ? new Response(JSON.stringify({}), { status: 401, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(sessionFor('viewer-b')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
    }
    if (path === '/auth/browser/refresh') {
      expect(new Headers(init?.headers).has('X-Finitude-Account-Viewer')).toBe(false);
      return new Response(JSON.stringify(sessionFor('viewer-b')), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Finitude-Account-Viewer': 'viewer-b'
        }
      });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(getBrowserSession()).resolves.toEqual(sessionFor('viewer-b'));
  expect(isAccountOperationCurrent(priorGuard)).toBe(false);
  expect(changes).toEqual(['login']);
  expect(sessionChecks).toBe(3);
  unsubscribe();
});

test('a stale login generation cannot publish another account transition', async () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let loginCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== '/auth/browser/login') throw new Error(`Unexpected request ${String(input)}`);
    loginCalls += 1;
    if (loginCalls === 1) await firstGate;
    return new Response(JSON.stringify(sessionFor(`viewer-${loginCalls}`)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }));

  const first = loginBrowserSession({ identifier: 'first', password: 'password' });
  await vi.waitFor(() => expect(loginCalls).toBe(1));
  const second = loginBrowserSession({ identifier: 'second', password: 'password' });
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(isAccountOperationCurrent(firstResult.guard)).toBe(false);
  expect(isAccountOperationCurrent(secondResult.guard)).toBe(true);
  const published = setItem.mock.calls
    .filter(([key]) => key === accountSessionChangeStorageKey)
    .map(([, value]) => JSON.parse(String(value)) as { reason: string });
  expect(published).toHaveLength(1);
  expect(published[0]?.reason).toBe('login');
  setItem.mockRestore();
});
