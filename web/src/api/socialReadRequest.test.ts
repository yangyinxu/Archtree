import { z } from 'zod';
import { advanceAccountEpoch } from './accountEpoch';
import { socialReadRequest } from './socialReadRequest';
import { apiRequest } from './client';

const schema = z.object({ ready: z.boolean() }).strict();
const reply = () => new Response(JSON.stringify({ ready: true }), { headers: { 'X-Finitude-Account-Viewer': 'viewer-1' } });
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

afterEach(() => advanceAccountEpoch());

/** Quota hints remain separate from payloads and private response identities. */
const limited = (seconds = '2') => new Response(JSON.stringify({ code: 'rate_limited' }), {
  status: 429, headers: { 'Retry-After': seconds }
});
const concurrent = (seconds: string | null = '2', message = 'Too many concurrent requests.') => new Response(JSON.stringify({ message }), {
  status: 429, headers: seconds === null ? {} : { 'Retry-After': seconds }
});
const unavailable = () => new Response(JSON.stringify({ code: 'room_unavailable' }), { status: 503 });

test('a quota 429 stays terminal while queued and later GETs honor cooling after the idle queue disappears', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockImplementation(async () => reply()).mockResolvedValueOnce(limited());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
    const failed = expect(first).rejects.toMatchObject({ status: 429, retryAfterSeconds: 2 });
    const queued = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' });
    await flush();
    await failed;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toEqual({ ready: true });
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockResolvedValueOnce(limited('3'));
    await expect(socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' }))
      .rejects.toMatchObject({ status: 429 });
    await flush();
    const later = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(later).resolves.toEqual({ ready: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('a known temporary invitation GET denial recovers after its monotonic hint while following GETs remain serialized', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let finishRetry!: (response: Response) => void;
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent())
      .mockReturnValueOnce(new Promise<Response>(resolve => { finishRetry = resolve; })).mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    const queued = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
    await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 86_400_000);
    await vi.advanceTimersByTimeAsync(1_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    finishRetry(reply());
    expect(await first).toEqual({ ready: true }); await expect(queued).resolves.toEqual({ ready: true });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/social/v1/room-invitations', '/api/social/v1/room-invitations', '/api/social/v1/rooms/current'
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { finishRetry?.(reply()); advanceAccountEpoch(); vi.useRealTimers(); }
});

test('temporary concurrency recovery exhausts the same three attempts and never creates a fourth retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockImplementation(async () => concurrent()); vi.stubGlobal('fetch', fetcher);
    const read = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(3_999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toMatchObject({ status: 429, message: 'Too many concurrent requests.', retryAfterSeconds: 2 });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test.each([
  ['503, 429, success', ['503', '429', 'success'], undefined],
  ['429, 503, success', ['429', '503', 'success'], undefined],
  ['503, 429, 503', ['503', '429', '503'], 503],
  ['429, 503, 429', ['429', '503', '429'], 429]
] as const)('mixed %s shares the original three-attempt budget', async (_name, failures, terminalStatus) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn();
    for (const failure of failures) fetcher.mockResolvedValueOnce(failure === '503' ? unavailable() : failure === '429' ? concurrent() : reply());
    vi.stubGlobal('fetch', fetcher);
    const read = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(2_300);
    if (terminalStatus) expect(await read).toMatchObject({ status: terminalStatus }); else expect(await read).toEqual({ ready: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test.each([null, '0', '-1', '1.5', '1e1', '+2', '02', 'unknown', 'Wed, 21 Oct 2026 07:28:00 GMT', '30', '31', '60', '900'])
('a known concurrency denial with missing, malformed, or too-long hint %s remains terminal', async seconds => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent(seconds)); vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' })).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test.each(['Too many requests. Please try again later.', 'Unknown denial.', 'Too many concurrent media requests.',
  ' Too many concurrent requests.', 'Too many concurrent requests. Extra information.'])
('429 message %s remains terminal and only cools a subsequent GET', async message => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent('2', message)).mockResolvedValueOnce(reply()); vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' })).rejects.toMatchObject({ status: 429 });
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(1_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(next).resolves.toEqual({ ready: true }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test.each(['rate_limited', 'capacity_exceeded', 'room_unavailable'])('coded denial %s cannot masquerade as temporary concurrency admission', async code => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const denial = new Response(JSON.stringify({ message: 'Too many concurrent requests.', code }), { status: 429, headers: { 'Retry-After': '2' } });
    const fetcher = vi.fn().mockResolvedValueOnce(denial).mockResolvedValueOnce(reply()); vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' })).rejects.toMatchObject({ status: 429, code });
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(1_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(next).resolves.toEqual({ ready: true }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test.each(['abort', 'account epoch'])('%s during concurrency recovery prevents another fetch with the old identity', async cause => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent()).mockResolvedValueOnce(reply()); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const read = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1', signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000); expect(fetcher).toHaveBeenCalledTimes(1);
    if (cause === 'abort') controller.abort(); else advanceAccountEpoch();
    expect(await read).toMatchObject({ name: 'AbortError' });
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(5_000); await expect(next).resolves.toEqual({ ready: true });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/social/v1/room-invitations', '/api/social/v1/capabilities']);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('a retry hint equal to the remaining active deadline stays terminal rather than waiting past it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let finishFirst!: (response: Response) => void;
  try {
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finishFirst = resolve; })); vi.stubGlobal('fetch', fetcher);
    const read = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(28_000); finishFirst(concurrent()); await flush();
    expect(await read).toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(5_000); expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  } finally { finishFirst?.(reply()); advanceAccountEpoch(); vi.useRealTimers(); }
});

test('recovery cooling and its retry transport share the original active thirty-second deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let finishRetry!: (response: Response) => void;
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent('29'))
      .mockReturnValueOnce(new Promise<Response>(resolve => { finishRetry = resolve; })).mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    const queued = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(28_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(await first).toMatchObject({ code: 'social_read_timeout' });
    await expect(queued).resolves.toEqual({ ready: true }); expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    finishRetry(unavailable()); await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/social/v1/room-invitations', '/api/social/v1/room-invitations', '/api/social/v1/capabilities'
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { finishRetry?.(reply()); advanceAccountEpoch(); vi.useRealTimers(); }
});

test('an account-bound response mismatch after concurrency recovery remains terminal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const mismatched = new Response(JSON.stringify({ ready: true }), { headers: { 'X-Finitude-Account-Viewer': 'viewer-2' } });
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent()).mockResolvedValueOnce(mismatched); vi.stubGlobal('fetch', fetcher);
    const read = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(2_000); expect(await read).toMatchObject({ code: 'account_viewer_mismatch' });
    await vi.advanceTimersByTimeAsync(5_000); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('cooling is monotonic, bounded to sixty seconds, and gives the eventual dispatch its full deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let resolveRead!: (response: Response) => void;
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(limited('900'))
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveRead = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    let settled = false;
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' })
      .then(value => { settled = true; return value; });
    vi.setSystemTime(Date.now() + 86_400_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() - 172_800_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    resolveRead(reply());
    await expect(next).resolves.toEqual({ ready: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { resolveRead?.(reply()); advanceAccountEpoch(); vi.useRealTimers(); }
});

test('canceling a cooling GET is immediate and cannot dispatch later or hold a following POST query', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValue(reply());
    vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }))
      .rejects.toMatchObject({ status: 429 });
    const controller = new AbortController();
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1', signal: controller.signal });
    const canceled = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    controller.abort();
    await canceled;
    const post = socialReadRequest('/api/social/v1/listening-status/query', schema, {
      accountViewer: 'viewer-1', method: 'POST', body: '{}'
    });
    await expect(post).resolves.toEqual({ ready: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/social/v1/rooms/current', '/api/social/v1/listening-status/query'
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('an account epoch cancels cooling before fresh credentials can dispatch and clears its admission hint', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValue(reply());
    vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }))
      .rejects.toMatchObject({ status: 429 });
    const old = socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' });
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    advanceAccountEpoch();
    await rejected;
    await expect(socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' }))
      .resolves.toEqual({ ready: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/social/v1/rooms/current', '/api/social/v1/capabilities'
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('POST query failures neither retry automatically nor install GET cooling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(concurrent()).mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'social_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/listening-status/query', schema, {
      accountViewer: 'viewer-1', method: 'POST', body: '{}'
    })).rejects.toMatchObject({ status: 429 });
    await expect(socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' }))
      .resolves.toEqual({ ready: true });
    await expect(socialReadRequest('/api/social/v1/listening-status/query', schema, {
      accountViewer: 'viewer-1', method: 'POST', body: '{}'
    })).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('durable mutations keep their original terminal outcome and dispatch independently of GET cooling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(limited('60')).mockResolvedValueOnce(limited('60'));
    vi.stubGlobal('fetch', fetcher);
    await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }))
      .rejects.toMatchObject({ status: 429 });
    await expect(apiRequest('/api/social/v1/room-commands', schema, {
      accountViewer: 'viewer-1', method: 'POST', body: '{"commandId":"original-command"}'
    })).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body).toBe('{"commandId":"original-command"}');
    expect(vi.getTimerCount()).toBe(0);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('cooling metadata retains at most sixteen short-lived viewer entries and expires without new requests', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const fetcher = vi.fn().mockImplementation(async () => limited());
    vi.stubGlobal('fetch', fetcher);
    for (let viewer = 0; viewer < 20; viewer++) {
      await expect(socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: `viewer-${viewer}` }))
        .rejects.toMatchObject({ status: 429 });
    }
    await flush();
    expect(vi.getTimerCount()).toBe(16);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(20);
  } finally { advanceAccountEpoch(); vi.useRealTimers(); }
});

test('a social refresh burst waits for its account read before starting another', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise(value => { resolve = value; })).mockResolvedValueOnce(reply());
  vi.stubGlobal('fetch', fetcher);
  const first = socialReadRequest('/api/social/v1/me/profile', schema, { accountViewer: 'viewer-1' });
  const next = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  resolve(reply());
  await expect(first).resolves.toEqual({ ready: true });
  await expect(next).resolves.toEqual({ ready: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('an account transition cancels queued reads before they can use replacement credentials', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise(value => { resolve = value; }));
  vi.stubGlobal('fetch', fetcher);
  const first = socialReadRequest('/api/social/v1/me/profile', schema, { accountViewer: 'viewer-1' });
  const next = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
  const firstSettled = first.catch(() => undefined);
  const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  advanceAccountEpoch(); resolve(reply());
  await firstSettled; await rejected;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('a GET may recover from one transient transaction failure while quota failures remain terminal', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 'room_unavailable' }), { status: 503 }))
    .mockResolvedValueOnce(reply()).mockResolvedValueOnce(new Response('{}', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' })).resolves.toEqual({ ready: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(socialReadRequest('/api/social/v1/room-invitations', schema, { accountViewer: 'viewer-1' })).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('a new account epoch starts its own queue even when the old transport ignores abort', async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(reply());
  vi.stubGlobal('fetch', fetcher);
  const old = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
  const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await flush();
  advanceAccountEpoch();
  let completed = false;
  const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' })
    .then(result => { completed = true; return result; });
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(completed).toBe(true);
  await oldRejected;
  await expect(next).resolves.toEqual({ ready: true });
  resolveOld(reply());
  await flush();
});

test('canceling a queued read settles it immediately without letting later reads overtake the active one', async () => {
  let resolveFirst!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(reply());
  vi.stubGlobal('fetch', fetcher);
  const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
  await flush();
  const controller = new AbortController();
  let canceled = false;
  const second = socialReadRequest('/api/social/v1/me/profile', schema, { accountViewer: 'viewer-1', signal: controller.signal })
    .catch(error => { canceled = true; return error; });
  const third = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
  controller.abort();
  await flush();
  expect(canceled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  resolveFirst(reply());
  await first;
  expect(await second).toMatchObject({ name: 'AbortError' });
  await third;
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/social/v1/rooms/current', '/api/social/v1/capabilities']);
});

test('an active cancellation rejects promptly but keeps its queue slot until an uncooperative transport settles', async () => {
  let resolveFirst!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(reply());
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  let canceled = false;
  const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1', signal: controller.signal })
    .catch(error => { canceled = true; return error; });
  await flush();
  const second = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
  controller.abort();
  await flush();
  expect(canceled).toBe(true);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  resolveFirst(reply());
  expect(await first).toMatchObject({ name: 'AbortError' });
  await second;
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a stalled read has a 30-second dispatch deadline and cannot retry after releasing the queue', async () => {
  vi.useFakeTimers();
  let resolveFirst!: (response: Response) => void;
  try {
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' });
    const failed = expect(first).rejects.toMatchObject({ kind: 'network', code: 'social_read_timeout' });
    const second = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await failed;
    await expect(second).resolves.toEqual({ ready: true });
    resolveFirst(new Response(JSON.stringify({ code: 'room_unavailable' }), { status: 503 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { resolveFirst?.(reply()); vi.useRealTimers(); }
});

test('each queued read receives a fresh deadline only when it starts', async () => {
  vi.useFakeTimers();
  const responses: Array<(response: Response) => void> = [];
  try {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { responses.push(resolve); }));
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    let secondSettled = false;
    const second = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' })
      .catch(error => { secondSettled = true; return error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await first).toMatchObject({ code: 'social_read_timeout' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(secondSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({ code: 'social_read_timeout' });
  } finally { for (const resolve of responses) resolve(reply()); await flush(); vi.useRealTimers(); }
});

test('the deadline covers response body decoding and safely consumes its late rejection', async () => {
  vi.useFakeTimers();
  let rejectBody!: (error: Error) => void;
  try {
    const response = reply();
    vi.spyOn(response, 'json').mockImplementation(() => new Promise((_, reject) => { rejectBody = reject; }));
    const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    const second = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ code: 'social_read_timeout' });
    await expect(second).resolves.toEqual({ ready: true });
    rejectBody(new Error('Late body failure'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { rejectBody?.(new Error('Cleanup')); vi.useRealTimers(); }
});

test('a canceled active transport still releases its queue slot at its deadline', async () => {
  vi.useFakeTimers();
  let rejectFirst!: (error: Error) => void;
  try {
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1', signal: controller.signal })
      .catch(error => error);
    await flush();
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    const next = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(next).resolves.toEqual({ ready: true });
    rejectFirst(new Error('Late canceled transport failure'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { rejectFirst?.(new Error('Cleanup')); vi.useRealTimers(); }
});

test('a pre-aborted read never dispatches or blocks the next read', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); controller.abort();
  await expect(socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1', signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  await expect(socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' })).resolves.toEqual({ ready: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('a transient read failure retains its existing three-attempt bound and serializes following reads', async () => {
  vi.useFakeTimers();
  try {
    const unavailable = () => new Response(JSON.stringify({ code: 'social_unavailable' }), { status: 503 });
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    const first = socialReadRequest('/api/social/v1/rooms/current', schema, { accountViewer: 'viewer-1' }).catch(error => error);
    const second = socialReadRequest('/api/social/v1/capabilities', schema, { accountViewer: 'viewer-1' });
    await vi.advanceTimersByTimeAsync(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ status: 503 });
    await expect(second).resolves.toEqual({ ready: true });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/social/v1/rooms/current', '/api/social/v1/rooms/current', '/api/social/v1/rooms/current', '/api/social/v1/capabilities'
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
