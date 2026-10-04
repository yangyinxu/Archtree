import { roomFixture } from '../test/roomFixture';
import { advanceAccountEpoch } from './accountEpoch';
import { getRoomMediaTrack, roomMediaPageSchema, searchRoomMedia } from './roomMedia';
import { roomClientId } from './roomClientId';

beforeEach(() => advanceAccountEpoch());
const reply = (value: unknown, viewer = 'viewer-1') => new Response(JSON.stringify(value), { headers: {
  'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewer
} });

test('room media discovery encodes bounded literal queries and exact track reads with current account and document guards', async () => {
  const { entryId: _entryId, ...item } = roomFixture().queue[0];
  const cursor = 'synthetic-cursor.' + 'a'.repeat(43);
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ items: [item], nextCursor: cursor }))
    .mockResolvedValueOnce(reply({ items: [], nextCursor: null })).mockResolvedValueOnce(reply({ item }))
    .mockResolvedValueOnce(reply({ item: null }));
  vi.stubGlobal('fetch', fetcher);
  expect(await searchRoomMedia('viewer-1', { query: '  Quiet + Water  ' })).toEqual({ items: [item], nextCursor: cursor });
  expect(await searchRoomMedia('viewer-1', { query: 'Quiet + Water', cursor })).toEqual({ items: [], nextCursor: null });
  expect(await getRoomMediaTrack('viewer-1', item.mediaTrackId)).toEqual({ item });
  expect(await getRoomMediaTrack('viewer-1', 'f'.repeat(24))).toEqual({ item: null });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/social/v1/room-media/search?q=Quiet+%2B+Water',
    `/api/social/v1/room-media/search?q=Quiet+%2B+Water&cursor=${cursor}`,
    `/api/social/v1/room-media/${item.mediaTrackId}`, `/api/social/v1/room-media/${'f'.repeat(24)}`]);
  for (const [, options] of fetcher.mock.calls) {
    expect(new Headers(options.headers).get('X-Finitude-Room-Client')).toBe(roomClientId());
    expect(new Headers(options.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1'); expect(options.body).toBeUndefined();
  }
});

test('room media discovery rejects oversized pages, duplicate descriptors and private or mismatched exact results', async () => {
  const { entryId: _entryId, ...item } = roomFixture().queue[0];
  expect(roomMediaPageSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true);
  for (const value of [{ items: [item, item], nextCursor: null }, { items: [], nextCursor: '' },
    { items: [{ ...item, etag: 'private' }], nextCursor: null }, { items: [], nextCursor: null, total: 1 }]) {
    expect(roomMediaPageSchema.safeParse(value).success).toBe(false);
  }
  expect(roomMediaPageSchema.safeParse({ items: Array.from({ length: 51 }, (_, index) => {
    const mediaTrackId = index.toString(16).padStart(24, '0');
    return { ...item, mediaTrackId, streamUrl: `/content/mediaTrack/stream/${mediaTrackId}?revision=${item.mediaRevision}` };
  }), nextCursor: null }).success).toBe(false);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ item })));
  await expect(getRoomMediaTrack('viewer-1', 'f'.repeat(24))).rejects.toMatchObject({ kind: 'invalid-response' });
});

test('room media inputs fail before transport and canceled or foreign-account reads cannot return cached content', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ items: [], nextCursor: null }, 'viewer-2'));
  vi.stubGlobal('fetch', fetcher);
  for (const query of ['song\n', 'x'.repeat(101)]) expect(() => searchRoomMedia('viewer-1', { query })).toThrow();
  expect(() => searchRoomMedia('viewer-1', { cursor: 'forged' })).toThrow();
  expect(() => getRoomMediaTrack('viewer-1', '../rooms/current')).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(searchRoomMedia('viewer-1')).rejects.toMatchObject({ code: 'account_viewer_mismatch' });
  const controller = new AbortController(); controller.abort();
  await expect(getRoomMediaTrack('viewer-1', 'a'.repeat(24), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(searchRoomMedia('viewer-1', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
