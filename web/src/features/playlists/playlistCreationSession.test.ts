import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { playlistQueryKeys, type PlaylistDetail } from '../../api/playlists';
import { createPlaylistCreationSession, playlistCreationSession } from './playlistCreationSession';

const detail = (name = 'Quiet', id = 'playlist-1'): PlaylistDetail => ({ id, name, revision: 1, items: [], itemCount: 0,
  artworkUrl: '', createdAt: '2026-09-16T12:00:00.000Z', updatedAt: '2026-09-16T12:00:00.000Z' });
const uncertain = () => new ApiError('Unconfirmed', 'network');
const setup = () => {
  const send = vi.fn<(input: Parameters<typeof import('../../api/playlists').createPlaylist>[0]) => Promise<PlaylistDetail>>();
  const client = new QueryClient();
  const session = createPlaylistCreationSession(send);
  session.ensure('alice', client);
  return { send, client, session };
};

test('an unknown create survives presentation reattachment and retries only the immutable original intent', async () => {
  const { send, client, session } = setup();
  send.mockRejectedValueOnce(uncertain()).mockResolvedValueOnce(detail());
  await session.start('alice', '  Quiet  ');
  const original = session.getSnapshot().intent;
  expect(original?.name).toBe('Quiet');
  session.ensure('alice', client);
  expect(session.getSnapshot().intent).toBe(original);
  await session.start('alice', 'Different');
  expect(send).toHaveBeenCalledTimes(1);
  await session.retry('alice');
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(session.getSnapshot()).toMatchObject({ status: 'confirmed', result: detail() });
  expect(client.getQueryData(playlistQueryKeys.detail('alice', 'playlist-1'))).toEqual(detail());
  client.clear();
});

test('confirmed creation releases its intent once and permits an intentionally new same-name Playlist', async () => {
  const { send, client, session } = setup();
  send.mockResolvedValue(detail());
  await session.start('alice', 'Quiet');
  const key = session.getSnapshot().intent!.key;
  await session.start('alice', 'Quiet');
  expect(send).toHaveBeenCalledTimes(1);
  expect(session.takeConfirmed('alice', key)).toEqual(detail());
  expect(session.takeConfirmed('alice', key)).toBeNull();
  await session.start('alice', 'Quiet');
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(key);
  client.clear();
});

test('only explicit abandonment of the current unknown intent permits a new identity', async () => {
  const { send, client, session } = setup();
  send.mockRejectedValueOnce(uncertain()).mockResolvedValueOnce(detail('Quiet', 'playlist-2'));
  await session.start('alice', 'Quiet');
  const key = session.getSnapshot().intent!.key;
  expect(session.abandon('bob', key)).toBe(false);
  expect(session.abandon('alice', 'stale-key')).toBe(false);
  expect(session.abandon('alice', key)).toBe(true);
  await session.start('alice', 'Quiet');
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(key);
  expect(session.abandon('alice', key)).toBe(false);
  expect(session.getSnapshot().result?.id).toBe('playlist-2');
  client.clear();
});

test.each([400, 401, 403, 404, 409, 422])('a definite HTTP %s rejection retires the rejected identity', async status => {
  const { send, client, session } = setup();
  send.mockRejectedValueOnce(new ApiError('Rejected', 'http', status)).mockResolvedValueOnce(detail());
  await session.start('alice', 'Quiet');
  expect(session.getSnapshot()).toMatchObject({ status: 'rejected', intent: null });
  await session.start('alice', 'Quiet');
  expect(send.mock.calls[0][0].idempotencyKey).not.toBe(send.mock.calls[1][0].idempotencyKey);
  client.clear();
});

test.each([
  ['network', uncertain()], ['malformed acknowledgement', new ApiError('Invalid response', 'invalid-response', 201)],
  ['408', new ApiError('Timeout', 'http', 408)], ['425', new ApiError('Wait', 'http', 425)],
  ['429', new ApiError('Throttled', 'http', 429)], ['503', new ApiError('Unavailable', 'http', 503)],
  ['in progress', new ApiError('Busy', 'http', 409, 'idempotency_in_progress')], ['aborted', new DOMException('Aborted', 'AbortError')]
])('a dispatched %s outcome keeps the original identity', async (_label, error) => {
  const { send, client, session } = setup();
  send.mockRejectedValue(error);
  await session.start('alice', 'Quiet');
  const intent = session.getSnapshot().intent;
  expect(session.getSnapshot().status).toBe('uncertain');
  await session.retry('alice');
  expect(session.getSnapshot().intent).toBe(intent);
  expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
  client.clear();
});

test.each(['resolve', 'reject'] as const)('a late %s from the previous account cannot replace a new pending creation', async outcome => {
  const { send, client, session } = setup();
  let resolve!: (result: PlaylistDetail) => void, reject!: (error: unknown) => void;
  send.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; })).mockResolvedValueOnce(detail('New', 'playlist-bob'));
  const pending = session.start('alice', 'Quiet');
  advanceAccountEpoch();
  session.ensure('bob', client);
  await session.start('bob', 'New');
  const current = session.getSnapshot();
  if (outcome === 'resolve') resolve(detail()); else reject(uncertain());
  await pending;
  expect(session.getSnapshot()).toBe(current);
  expect(client.getQueryData(playlistQueryKeys.detail('alice', 'playlist-1'))).toBeUndefined();
  expect(client.getQueryData(playlistQueryKeys.detail('bob', 'playlist-bob'))).toEqual(detail('New', 'playlist-bob'));
  client.clear();
});

test('pending dispatch excludes concurrent retries and abandonment', async () => {
  const { send, client, session } = setup();
  let resolve!: (result: PlaylistDetail) => void;
  send.mockRejectedValueOnce(uncertain()).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  await session.start('alice', 'Quiet');
  const key = session.getSnapshot().intent!.key;
  const pending = session.retry('alice');
  await session.retry('alice'); await session.start('alice', 'Another');
  expect(session.abandon('alice', key)).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
  resolve(detail()); await pending;
  client.clear();
});

test('refresh failure cannot make a confirmed receipt uncertain', async () => {
  const { send, client, session } = setup();
  vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('Read failed'));
  send.mockResolvedValue(detail());
  await session.start('alice', 'Quiet');
  expect(session.getSnapshot().status).toBe('confirmed');
  client.clear();
});

test('the shared session clears private state synchronously on account exit, including a same-viewer login', async () => {
  const client = new QueryClient();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Unconfirmed')));
  playlistCreationSession.ensure('alice', client);
  await playlistCreationSession.start('alice', 'Private draft');
  expect(playlistCreationSession.getSnapshot().intent?.name).toBe('Private draft');
  advanceAccountEpoch();
  expect(playlistCreationSession.getSnapshot()).toMatchObject({ viewerId: '', intent: null, error: null });
  playlistCreationSession.ensure('alice', client);
  expect(playlistCreationSession.getSnapshot().intent).toBeNull();
  playlistCreationSession.reset(); client.clear();
});

test('a retained intent cannot be retried after the 24-hour receipt window or silently receive a fresh key', async () => {
  const { send, client, session } = setup();
  send.mockRejectedValue(uncertain());
  await session.start('alice', 'Quiet');
  const intent = session.getSnapshot().intent!;
  vi.spyOn(Date, 'now').mockReturnValue(intent.expiresAt);
  await session.retry('alice');
  await session.start('alice', 'Quiet');
  expect(send).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot()).toMatchObject({ status: 'expired', intent });
  expect(session.abandon('alice', intent.key)).toBe(true);
  client.clear();
});
