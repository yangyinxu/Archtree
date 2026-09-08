import { z } from 'zod';

const viewerA = 'viewer-a';
const viewerB = 'viewer-b';
const session = (viewer = viewerA) => ({ user: {
  id: viewer, email: `${viewer}@example.test`, role: 'user', displayName: viewer,
  avatarRevision: 0, avatar: null, emailVerified: true
} });
const json = (body: unknown, status = 200, viewer = viewerA) => Response.json(body, {
  status, headers: { 'X-Finitude-Account-Viewer': viewer }
});
const empty = () => new Response(null, {
  status: 204, headers: { 'X-Finitude-Account-Viewer': viewerA }
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const stale = { status: 409, code: 'account_viewer_mismatch' };

beforeEach(() => { vi.resetModules(); });

const clients = async () => {
  const client = await import('./client');
  const epoch = await import('./accountEpoch');
  return {
    ...client, ...epoch,
    request: (kind: 'json' | 'empty', signal?: AbortSignal) => kind === 'json'
      ? client.apiRequest('/content/me/saves/status', z.object({ ready: z.boolean() }), {
        accountViewer: viewerA, signal
      })
      : client.apiRequestNoContent('/auth/activity/listening-history', {
        method: 'DELETE', body: '{}', accountViewer: viewerA, signal
      })
  };
};

test.each(['json', 'empty'] as const)('a late %s 401 cannot inspect or clear the replacement account', async (kind) => {
  const { request, advanceAccountEpoch } = await clients();
  const late = deferred<Response>();
  const fetchMock = vi.fn().mockReturnValue(late.promise);
  vi.stubGlobal('fetch', fetchMock);
  const pending = request(kind);
  const rejected = expect(pending).rejects.toMatchObject(stale);
  advanceAccountEpoch();
  late.resolve(json({}, 401));
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(['json', 'empty'] as const)(
  'a late %s viewer-mismatch response cannot publish a replacement-account transition', async (kind) => {
    const { request, advanceAccountEpoch } = await clients();
    const { subscribeToAccountSessionChanges } = await import('./accountSessionEvents');
    const changes = vi.fn();
    const unsubscribe = subscribeToAccountSessionChanges(changes);
    const late = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(late.promise));
    const pending = request(kind);
    const rejected = expect(pending).rejects.toMatchObject(stale);
    advanceAccountEpoch();
    late.resolve(json({ code: 'account_viewer_mismatch' }, 409));
    await rejected;
    expect(changes).not.toHaveBeenCalled();
    unsubscribe();
  }
);

test.each(['json', 'empty'] as const)(
  'switching accounts while decoding a %s error cannot publish its late mismatch event', async (kind) => {
    const { request, advanceAccountEpoch } = await clients();
    const { subscribeToAccountSessionChanges } = await import('./accountSessionEvents');
    const changes = vi.fn();
    const unsubscribe = subscribeToAccountSessionChanges(changes);
    const body = deferred<unknown>();
    const response = json({}, 409);
    const reading = vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const pending = request(kind);
    const rejected = expect(pending).rejects.toMatchObject(stale);
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1));
    advanceAccountEpoch();
    body.resolve({ code: 'account_viewer_mismatch' });
    await rejected;
    expect(changes).not.toHaveBeenCalled();
    unsubscribe();
  }
);

test('a stale recovery waiting for the shared lock cannot read or change cookies', async () => {
  const { request, advanceAccountEpoch } = await clients();
  const lock = deferred<void>();
  const lockRequest = vi.fn(async (_name, _options, operation) => {
    await lock.promise;
    return operation();
  });
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
  const fetchMock = vi.fn().mockResolvedValue(json({}, 401));
  vi.stubGlobal('fetch', fetchMock);
  const pending = request('empty');
  const rejected = expect(pending).rejects.toMatchObject(stale);
  await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledTimes(1));
  advanceAccountEpoch();
  lock.resolve();
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(['expired', 'replacement', 'conflict'] as const)(
  'an account transition during the session read prevents %s recovery from writing cookies', async (outcome) => {
    const { request, advanceAccountEpoch } = await clients();
    const reading = deferred<Response>();
    const fetchMock = vi.fn((path: string) => path === '/auth/browser/session'
      ? reading.promise : Promise.resolve(json({}, 401)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = request('json');
    const rejected = expect(pending).rejects.toMatchObject(stale);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    advanceAccountEpoch();
    reading.resolve(outcome === 'expired' ? json({}, 401)
      : outcome === 'conflict' ? json({ code: 'browser_session_identity_conflict' }, 409)
        : json(session(viewerB)));
    await rejected;
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/content/me/saves/status', '/auth/browser/session'
    ]);
  }
);

test.each(['json', 'empty'] as const)('a changed epoch after rotation prevents the %s mutation retry', async (kind) => {
  const { request, advanceAccountEpoch } = await clients();
  const rotating = deferred<Response>();
  const fetchMock = vi.fn((path: string) => path === '/auth/browser/refresh'
    ? rotating.promise : Promise.resolve(json({}, 401)));
  vi.stubGlobal('fetch', fetchMock);
  const pending = request(kind);
  const rejected = expect(pending).rejects.toMatchObject(stale);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  advanceAccountEpoch();
  rotating.resolve(json(session()));
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('an aborted request does not retry its mutation after shared refresh completes', async () => {
  const { request } = await clients();
  const controller = new AbortController();
  const rotating = deferred<Response>();
  const fetchMock = vi.fn((path: string) => path === '/auth/browser/refresh'
    ? rotating.promise : Promise.resolve(json({}, 401)));
  vi.stubGlobal('fetch', fetchMock);
  const pending = request('empty', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  controller.abort();
  rotating.resolve(json(session()));
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('an already locked account action bypasses a refresh queued behind its own lock', async () => {
  const { apiRequestNoContent } = await clients();
  const { signOutAccountEverywhere } = await import('./accountLifecycle');
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  const mutation = deferred<Response>();
  let accessIsCurrent = false;
  let mutationCalls = 0;
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/logout-all' && ++mutationCalls === 1) return mutation.promise;
    if (path === '/auth/browser/session') return accessIsCurrent ? json(session()) : json({}, 401);
    if (path === '/auth/browser/refresh') {
      accessIsCurrent = true;
      return json(session());
    }
    return accessIsCurrent ? empty() : json({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);
  const exit = signOutAccountEverywhere(viewerA);
  await vi.waitFor(() => expect(mutationCalls).toBe(1));
  const concurrent = apiRequestNoContent('/auth/activity/listening-history', { accountViewer: viewerA });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  // Let the second 401 queue its normal refresh before completing the owning request.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  mutation.resolve(json({}, 401));
  await Promise.all([exit, concurrent]);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
  await expect(runBrowserSessionTransition({ kind: 'refresh' }, async () => 'released')).resolves.toBe('released');
});

test('a replacement epoch starts its own recovery instead of joining the stale refresh', async () => {
  const { request, advanceAccountEpoch } = await clients();
  const oldRead = deferred<Response>();
  let sessionReads = 0;
  let accessIsCurrent = false;
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/browser/session') {
      sessionReads += 1;
      return sessionReads === 1 ? oldRead.promise : json({}, 401);
    }
    if (path === '/auth/browser/refresh') {
      accessIsCurrent = true;
      return json(session());
    }
    return accessIsCurrent ? empty() : json({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);
  const first = request('empty');
  const rejected = expect(first).rejects.toMatchObject(stale);
  await vi.waitFor(() => expect(sessionReads).toBe(1));
  advanceAccountEpoch();
  const second = request('empty');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  oldRead.resolve(json({}, 401));
  await rejected;
  await second;
  expect(sessionReads).toBe(2);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/auth/browser/refresh')).toHaveLength(1);
});

test('a released transition scope cannot authorize another request', async () => {
  const { apiRequestNoContent } = await clients();
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  const scope = await runBrowserSessionTransition({ kind: 'refresh' }, async (_capability, _generation, owned) => owned);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(apiRequestNoContent('/auth/logout-all', {
    accountViewer: viewerA, sessionTransition: scope
  })).rejects.toMatchObject({ name: 'BrowserSessionTransitionUnavailableError' });
  expect(fetchMock).not.toHaveBeenCalled();
});
