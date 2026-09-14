import { z } from 'zod';
import { advanceAccountEpoch } from './accountEpoch';
import { socialReadRequest } from './socialReadRequest';

const schema = z.object({ ready: z.boolean() }).strict();
const reply = () => new Response(JSON.stringify({ ready: true }), { headers: { 'X-Finitude-Account-Viewer': 'viewer-1' } });

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
