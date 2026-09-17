import { getRoomCommunity, roomCommunitySchema, roomCommunityEventSchema, type RoomCommunity, type RoomCommunityEvent } from './roomCommunity';
import { advanceAccountEpoch } from './accountEpoch';
import { roomClientId } from './rooms';

const card = { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice' };
const community = (): RoomCommunity => ({ roomId: 'room-a', epoch: 2, revision: 3, events: [],
  requests: [{ requestId: 'request-a', mediaTrackId: 'a'.repeat(24), title: 'A quiet song', requestedBy: card, createdAtMs: 1_000_000 }],
  queueCredits: [{ entryId: 'entry-a', requestedBy: card }, { entryId: 'entry-b', requestedBy: null }] });
const reply = (value: unknown, viewer = 'viewer-1') => new Response(JSON.stringify(value), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer
} });
beforeEach(() => advanceAccountEpoch());

test('community reads preserve strict public metadata and use the shared account and tab identity', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ community: community() })); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  expect(await getRoomCommunity('viewer-1', 'room-a', controller.signal)).toEqual({ community: community() });
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('/api/social/v1/rooms/room-a/community');
  expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  expect(new Headers(options.headers).get('X-Finitude-Room-Client')).toBe(roomClientId());
  expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.signal.aborted).toBe(false);
  expect(options.body).toBeUndefined();
});

test('community projections reject private fields at every nested boundary', () => {
  const value = community(); expect(roomCommunitySchema.safeParse(value).success).toBe(true);
  for (const invalid of [
    { ...value, accountId: 'private' },
    { ...value, requests: [{ ...value.requests[0], ownerId: 'private' }] },
    { ...value, requests: [{ ...value.requests[0], requestedBy: { ...card, email: 'private@example.invalid' } }] },
    { ...value, queueCredits: [{ ...value.queueCredits[0], sessionId: 'private' }] },
    { ...value, queueCredits: [{ entryId: 'entry-a', requestedBy: { ...card, avatarUrl: '/private-avatar' } }] }
  ]) expect(roomCommunitySchema.safeParse(invalid).success).toBe(false);
});

test('community validation enforces bounded lists, unique identities and safe scalar values', () => {
  const value = community();
  for (const invalid of [
    { ...value, requests: [value.requests[0], value.requests[0]] },
    { ...value, queueCredits: [value.queueCredits[0], value.queueCredits[0]] },
    { ...value, requests: Array.from({ length: 21 }, (_, index) => ({ ...value.requests[0], requestId: `request-${index}` })) },
    { ...value, queueCredits: Array.from({ length: 101 }, (_, index) => ({ entryId: `entry-${index}`, requestedBy: null })) },
    { ...value, epoch: 0 }, { ...value, revision: 1.5 },
    { ...value, requests: [{ ...value.requests[0], createdAtMs: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...value, requests: [{ ...value.requests[0], mediaTrackId: 'not-an-id' }] },
    { ...value, requests: [{ ...value.requests[0], title: 'a'.repeat(501) }] }
  ]) expect(roomCommunitySchema.safeParse(invalid).success).toBe(false);
});

test('community read rejects another room or account and unsafe path identifiers', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ community: { ...community(), roomId: 'room-b' } }))
    .mockResolvedValueOnce(reply({ community: community() }, 'viewer-2'));
  vi.stubGlobal('fetch', fetcher);
  await expect(getRoomCommunity('viewer-1', 'room-a')).rejects.toMatchObject({ kind: 'invalid-response' });
  await expect(getRoomCommunity('viewer-1', 'room-a')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
  for (const id of ['../other', 'room-a?account=other', 'room-a\n']) expect(() => getRoomCommunity('viewer-1', id)).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('room activity validates fixed kinds, reaction tokens, current actors and bounded lifetimes', () => {
  const event: RoomCommunityEvent = { eventId: 'event-a', kind: 'reaction', actor: card, reaction: 'heart', createdAtMs: 1000, expiresAtMs: 31_000 };
  expect(roomCommunityEventSchema.safeParse(event).success).toBe(true);
  expect(roomCommunityEventSchema.safeParse({ ...event, kind: 'trackChanged', actor: null, reaction: null }).success).toBe(true);
  for (const invalid of [
    { ...event, actor: null }, { ...event, reaction: null }, { ...event, reaction: 'arbitrary text' },
    { ...event, kind: 'joined', reaction: 'heart' }, { ...event, kind: 'joined', actor: null, reaction: null },
    { ...event, kind: 'heartbeat', reaction: null }, { ...event, kind: 'hostChanged', actor: null, reaction: null },
    { ...event, expiresAtMs: 31_001 }, { ...event, expiresAtMs: 1000 }, { ...event, createdAtMs: -1 },
    { ...event, eventId: '../private' }, { ...event, text: 'unsolicited text' },
    { ...event, actor: { ...card, accountId: 'private', email: 'private@example.test' } }
  ]) expect(roomCommunityEventSchema.safeParse(invalid).success).toBe(false);
  expect(roomCommunitySchema.safeParse({ ...community(), events: [event, event] }).success).toBe(false);
  expect(roomCommunitySchema.safeParse({ ...community(), events: Array.from({ length: 21 }, (_, index) => ({ ...event, eventId: `event-${index}` })) }).success).toBe(false);
});

test('canceled and previous-account queued reads cannot populate community state', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ community: community() })); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); controller.abort();
  await expect(getRoomCommunity('viewer-1', 'room-a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const stale = getRoomCommunity('viewer-1', 'room-a'); advanceAccountEpoch();
  await expect(stale).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).not.toHaveBeenCalled();
});
