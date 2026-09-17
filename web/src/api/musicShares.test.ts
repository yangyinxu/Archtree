import { advanceAccountEpoch } from './accountEpoch';
import { getMusicShares, musicSharePageSchema, type MusicShareItem } from './musicShares';

const item = (): MusicShareItem => ({ shareId: `ms_${'b'.repeat(32)}`, peer: { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice' },
  contentId: 'a'.repeat(24), contentType: 'audioTrack', createdAtMs: 100, expiresAtMs: 200,
  content: { id: 'a'.repeat(24), contentType: 'audioTrack', title: 'A song', artworkUrl: '', artistNames: ['An artist'] } });
const reply = (data: unknown, viewer = 'viewer-1') => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer } });
beforeEach(() => advanceAccountEpoch());

test('share directions and cursors remain account-owned reads with cancellation', async () => {
  const page = { items: [item()], nextCursor: 'next-page' };
  const fetcher = vi.fn().mockImplementation(async () => reply(page)); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  expect(await getMusicShares('viewer-1', 'incoming', 'a+b/=', controller.signal)).toEqual(page);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('/api/social/v1/music-shares?direction=incoming&limit=20&cursor=a%2Bb%2F%3D');
  expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.signal.aborted).toBe(false);
  expect(options.body).toBeUndefined();
  await getMusicShares('viewer-1', 'outgoing');
  expect(fetcher.mock.calls[1][0]).toBe('/api/social/v1/music-shares?direction=outgoing&limit=20');
});

test('share projections reject historical payloads, private fields and mismatched current identities', () => {
  const value = item();
  for (const invalid of [
    { ...value, ownerId: 'private' }, { ...value, peer: { ...value.peer, email: 'private@example.test' } },
    { ...value, content: { ...value.content, streamUrl: '/private' } },
    { ...value, content: { ...value.content, id: 'b'.repeat(24) } },
    { ...value, content: { ...value.content, contentType: 'album' } },
    { ...value, shareId: 'not-a-share' }, { ...value, contentType: 'playlist' },
    { ...value, expiresAtMs: value.createdAtMs }, { ...value, createdAtMs: NaN },
    { ...value, content: { ...value.content, title: '🦊'.repeat(201) } },
    { ...value, content: { ...value.content, artistNames: ['🦊'.repeat(161)] } },
    { ...value, content: { ...value.content, artistNames: Array(21).fill('artist') } }
  ]) expect(musicSharePageSchema.safeParse({ items: [invalid], nextCursor: null }).success).toBe(false);
  expect(musicSharePageSchema.safeParse({ items: [{ ...value, content: null }], nextCursor: null }).success).toBe(true);
  expect(musicSharePageSchema.safeParse({ items: [{ ...value, content: { ...value.content, title: '🦊'.repeat(200), artistNames: ['🦊'.repeat(160)] } }], nextCursor: null }).success).toBe(true);
  expect(musicSharePageSchema.safeParse({ items: [value, value], nextCursor: null }).success).toBe(false);
  expect(musicSharePageSchema.safeParse({ items: [], nextCursor: null, accountId: 'private' }).success).toBe(false);
});

test('wrong-account, canceled and obsolete reads cannot populate a share list', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ items: [item()], nextCursor: null }, 'viewer-2')); vi.stubGlobal('fetch', fetcher);
  await expect(getMusicShares('viewer-1', 'incoming')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
  const controller = new AbortController(); controller.abort();
  await expect(getMusicShares('viewer-1', 'incoming', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const stale = getMusicShares('viewer-1', 'incoming'); advanceAccountEpoch();
  await expect(stale).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
