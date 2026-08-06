import {
  addPlaylistItem,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistMemberships,
  getPlaylistPage,
  playlistDetailSchema,
  playlistMembershipPageSchema,
  playlistNameSchema,
  playlistPageSchema,
  playlistQueryKeys,
  removePlaylistItem,
  renamePlaylist,
  reorderPlaylistItems
} from './playlists';

const track = {
  contentType: 'audioTrack',
  id: 'track-1',
  title: 'Blue Interval',
  artworkUrl: '',
  artistNames: ['Finite Ensemble'],
  albumId: null,
  albumTitle: null,
  duration: '3:24',
  streamUrl: '/content/audioTrack/stream/track-1'
} as const;

const summary = {
  id: 'playlist-1',
  name: 'Quiet sequence',
  itemCount: 1,
  artworkUrl: '/content/images/64b000000000000000000001',
  revision: 3,
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:05:00.000Z'
};

const detail = {
  ...summary,
  items: [{
    itemId: 'item-1',
    audioTrackId: track.id,
    addedAt: '2026-08-04T12:01:00.000Z',
    availability: 'ready' as const,
    audioTrack: track
  }]
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'X-Finitude-Account-Viewer': 'viewer-1'
  }
});

test('strict Playlist DTOs reject leaks and contradictory availability', () => {
  expect(playlistPageSchema.safeParse({ items: [summary], nextCursor: null }).success).toBe(true);
  expect(playlistPageSchema.safeParse({
    items: [{ ...summary, name: 'Cafe\u0301' }],
    nextCursor: null
  }).success).toBe(false);
  expect(playlistPageSchema.safeParse({ items: [{ ...summary, ownerUserId: 'private' }], nextCursor: null }).success).toBe(false);
  expect(playlistPageSchema.safeParse({
    items: [{ ...summary, artworkUrl: 'x'.repeat(2_049) }],
    nextCursor: null
  }).success).toBe(false);
  expect(playlistPageSchema.safeParse({
    items: [{ ...summary, artworkUrl: 'javascript:alert(1)' }],
    nextCursor: null
  }).success).toBe(false);
  expect(playlistPageSchema.safeParse({
    items: [{ ...summary, artworkUrl: 'data:image/svg+xml,unsafe' }],
    nextCursor: null
  }).success).toBe(false);
  expect(playlistDetailSchema.safeParse({
    ...detail,
    items: [{ ...detail.items[0], availability: 'unavailable', audioTrack: track }]
  }).success).toBe(false);
  expect(playlistDetailSchema.safeParse({ ...detail, itemCount: 2 }).success).toBe(false);
  expect(playlistMembershipPageSchema.safeParse({
    items: [{ audioTrackId: track.id, playlistIds: [summary.id] }]
  }).success).toBe(true);
  expect(playlistMembershipPageSchema.safeParse({
    items: [{ audioTrackId: track.id, playlistIds: [summary.id], ownerUserId: 'private' }]
  }).success).toBe(false);
});

test('Playlist names match the server NFC, trim, code-point, and control-character rules', () => {
  expect(playlistNameSchema.parse('  Cafe\u0301  ')).toBe('Café');
  expect(playlistNameSchema.safeParse('line\nbreak').success).toBe(false);
  expect(playlistNameSchema.safeParse('😀'.repeat(100)).success).toBe(true);
  expect(playlistNameSchema.safeParse('😀'.repeat(101)).success).toBe(false);
});

test('query keys are viewer-scoped and signed-out renders use a stable sentinel', () => {
  expect(playlistQueryKeys.list('viewer-a', { limit: 50 })).not.toEqual(
    playlistQueryKeys.list('viewer-b', { limit: 50 })
  );
  expect(playlistQueryKeys.list('', { limit: 50 })).toEqual([
    'listener', 'playlists', 'signed-out', { limit: 50 }
  ]);
  expect(playlistQueryKeys.detail('', '')).toEqual([
    'listener', 'playlist', 'signed-out', 'missing-playlist'
  ]);
});

test('Playlist reads pass AbortSignal and decode the bounded page', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ items: [summary], nextCursor: 'next-page' }))
    .mockResolvedValueOnce(jsonResponse(detail));
  vi.stubGlobal('fetch', fetchMock);

  await expect(getPlaylistPage('viewer-1', { limit: 50, cursor: 'opaque' }, controller.signal)).resolves.toEqual({
    items: [summary],
    nextCursor: 'next-page'
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/content/me/playlists?limit=50&cursor=opaque',
    expect.objectContaining({
      credentials: 'same-origin',
      signal: controller.signal
    })
  );
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  await expect(getPlaylist('viewer-1', 'playlist-1', controller.signal)).resolves.toEqual(detail);
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/content/me/playlists/playlist-1',
    expect.objectContaining({
      credentials: 'same-origin',
      signal: controller.signal
    })
  );
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
});

test('membership lookup is bounded, sorted, and abortable', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    items: [
      { audioTrackId: 'track-1', playlistIds: ['playlist-1'] },
      { audioTrackId: 'track-2', playlistIds: [] }
    ]
  }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(getPlaylistMemberships(
    'viewer-1',
    ['track-2', 'track-1', 'track-1'],
    controller.signal
  )).resolves.toEqual({
    items: [
      { audioTrackId: 'track-1', playlistIds: ['playlist-1'] },
      { audioTrackId: 'track-2', playlistIds: [] }
    ]
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/content/me/playlists/memberships?audioTrackIds=track-1%2Ctrack-2',
    expect.objectContaining({
      credentials: 'same-origin',
      signal: controller.signal
    })
  );
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
});

test('mutations send idempotency, viewer, and quoted revision headers', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === 'DELETE' && String(input) === '/content/me/playlists/playlist-1'
      ? new Response(null, {
          status: 204,
          headers: { 'X-Finitude-Account-Viewer': 'viewer-1' }
        })
      : jsonResponse(detail)
  ));
  vi.stubGlobal('fetch', fetchMock);

  await createPlaylist({
    viewerId: 'viewer-1',
    name: '  Quiet sequence  ',
    idempotencyKey: 'create-key'
  });
  await renamePlaylist({
    viewerId: 'viewer-1',
    playlistId: 'playlist-1',
    revision: 3,
    name: 'Quiet sequence',
    idempotencyKey: 'rename-key'
  });
  await addPlaylistItem({
    viewerId: 'viewer-1',
    playlistId: 'playlist-1',
    revision: 3,
    audioTrackId: 'track-1',
    idempotencyKey: 'add-key'
  });
  await removePlaylistItem({
    viewerId: 'viewer-1',
    playlistId: 'playlist-1',
    revision: 3,
    itemId: 'item-1',
    idempotencyKey: 'remove-key'
  });
  await reorderPlaylistItems({
    viewerId: 'viewer-1',
    playlistId: 'playlist-1',
    revision: 3,
    itemIds: ['item-1'],
    idempotencyKey: 'order-key'
  });
  await deletePlaylist({
    viewerId: 'viewer-1',
    playlistId: 'playlist-1',
    revision: 3,
    idempotencyKey: 'delete-key'
  });

  const [createCall, renameCall, addCall, removeCall, reorderCall, deleteCall] = fetchMock.mock.calls;
  const createHeaders = new Headers(createCall[1]?.headers);
  expect(createHeaders.get('Idempotency-Key')).toBe('create-key');
  expect(createHeaders.get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  expect(createHeaders.has('If-Match')).toBe(false);
  expect(JSON.parse(String(createCall[1]?.body))).toEqual({ name: 'Quiet sequence' });

  for (const call of [renameCall, addCall, removeCall, reorderCall, deleteCall]) {
    expect(new Headers(call[1]?.headers).get('If-Match')).toBe('"3"');
    expect(new Headers(call[1]?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  }
  expect(String(addCall[0])).toBe('/content/me/playlists/playlist-1/items');
  expect(String(removeCall[0])).toBe('/content/me/playlists/playlist-1/items/item-1');
  expect(JSON.parse(String(reorderCall[1]?.body))).toEqual({ itemIds: ['item-1'] });
});
