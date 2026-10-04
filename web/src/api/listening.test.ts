import { advanceAccountEpoch } from './accountEpoch';
import { getListeningFriends, getOwnListening, listeningStatusSchema, ownListeningSchema, sendListeningReport } from './listening';
const socialId = `s_${'a'.repeat(32)}`;
const item = { peer: { socialId, alias: 'Alice', handle: 'alice', iconSeed: 'alice' },
  track: { contentType: 'audioTrack', id: 'a'.repeat(24), title: 'Song', artworkUrl: '', artistNames: [] }, expiresAtMs: 25_000 };
const response = (value: unknown, viewer = 'alice') => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer } });
beforeEach(() => advanceAccountEpoch());
test('owned state and the listening-friends page preserve account fences, cancellation and an opaque cursor', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ listening: { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: 1000 } }))
    .mockImplementation(async () => response({ items: [item], nextCursor: 'signed.next-page_cursor' }));
  vi.stubGlobal('fetch', fetcher); const controller = new AbortController();
  expect((await getOwnListening('alice', controller.signal)).listening.enabled).toBe(false);
  expect(await getListeningFriends('alice', undefined, controller.signal)).toEqual({ items: [item], nextCursor: 'signed.next-page_cursor' });
  expect(fetcher.mock.calls[1][0]).toBe('/api/social/v1/listening-status/friends?limit=20');
  const options = fetcher.mock.calls[1][1];
  expect(options.method ?? 'GET').toBe('GET'); expect(options.body).toBeUndefined();
  expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.signal.aborted).toBe(false);
  expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('alice');
  await getListeningFriends('alice', 'signed.next-page_cursor');
  expect(fetcher.mock.calls[2][0]).toBe('/api/social/v1/listening-status/friends?limit=20&cursor=signed.next-page_cursor');
});
test('strict DTOs exclude private playback, room, account and historical fields and accept Unicode bounds', () => {
  expect(listeningStatusSchema.safeParse(item).success).toBe(true);
  for (const value of [{ ...item, positionMs: 20 }, { ...item, roomId: 'private' }, { ...item, peer: { ...item.peer, email: 'private' } },
    { ...item, track: { ...item.track, contentType: 'album' } }, { ...item, track: { ...item.track, title: '🦊'.repeat(201) } }]) expect(listeningStatusSchema.safeParse(value).success).toBe(false);
  expect(listeningStatusSchema.safeParse({ ...item, track: { ...item.track, title: '🦊'.repeat(200) } }).success).toBe(true);
  expect(ownListeningSchema.safeParse({ enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: 1000, publicationId: 'private' }).success).toBe(false);
});
test('duplicate peers, extra envelope fields and malformed cursors fail closed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ items: [item, item], nextCursor: null }))
    .mockResolvedValueOnce(response({ items: [item], nextCursor: null, total: 4 }))
    .mockResolvedValue(response({ items: [item], nextCursor: 'not a cursor' })));
  await expect(getListeningFriends('alice')).rejects.toBeDefined();
  await expect(getListeningFriends('alice')).rejects.toBeDefined();
  await expect(getListeningFriends('alice')).rejects.toBeDefined();
});
test('wrong-account response cannot populate private data and reports send one captured identity without retry', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ items: [item], nextCursor: null }, 'bob')).mockRejectedValue(new TypeError('network'));
  vi.stubGlobal('fetch', fetcher);
  await expect(getListeningFriends('alice')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
  const report = { clientId: 'client-document-01', publicationId: 'claim-command-01', expectedPreferenceRevision: 1, expectedPublisherRevision: 1, sequence: 2,
    state: 'stopped' as const, playbackSequence: 1, occurrenceId: 'occurrence-000001' };
  await expect(sendListeningReport('alice', report)).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2); expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(report);
});

test('artwork accepts only bounded safe public paths and credential-free HTTPS', () => {
  for (const artworkUrl of ['', '/artwork/image.webp', 'https://public.example/art.webp']) expect(listeningStatusSchema.safeParse({ ...item, track: { ...item.track, artworkUrl } }).success).toBe(true);
  for (const artworkUrl of ['//other.example/art', '/\\unsafe', 'javascript:alert(1)', 'http://other.example/art', 'https://name:password@public.example/art', '/' + 'x'.repeat(2048), '/bad\npath']) expect(listeningStatusSchema.safeParse({ ...item, track: { ...item.track, artworkUrl } }).success).toBe(false);
});
