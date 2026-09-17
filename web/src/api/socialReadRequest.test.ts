import { z } from 'zod';
import { advanceAccountEpoch } from './accountEpoch';
import { socialReadRequest } from './socialReadRequest';

const schema = z.object({ ready: z.boolean() }).strict();
const reply = () => new Response(JSON.stringify({ ready: true }), { headers: { 'X-Finitude-Account-Viewer': 'viewer-1' } });
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

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
