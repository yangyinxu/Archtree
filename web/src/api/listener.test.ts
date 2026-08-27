import { QueryClient } from '@tanstack/react-query';

import {
  getLibraryPage,
  getSaveStatuses,
  listenerHomeQuery,
  recordRecentlyPlayed,
  saveContent,
  unsaveContent
} from './listener';
import { getListenerCollectionPage } from './listenerCollections';
import { getListenerCapabilities } from './listenerCapabilities';

const homeResponse = { title: 'Home', sections: [] };
const collectionResponse = {
  pageItem: {
    id: 'page-item-1',
    pageSlug: 'home',
    title: 'Quiet albums',
    presentation: 'grid',
    mode: 'manual',
    contentType: 'album'
  },
  items: [],
  included: { albums: [], audioTracks: [] },
  limit: 20,
  nextCursor: null
};
const jsonResponse = (body: unknown, status = 200, viewerId?: string) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(viewerId ? { 'X-Finitude-Account-Viewer': viewerId } : {})
  }
});

test('reads strict listener rollout capabilities without authentication retries', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ playlists: true }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(getListenerCapabilities(controller.signal)).resolves.toEqual({ playlists: true });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/listener/v1/capabilities',
    expect.objectContaining({
      credentials: 'same-origin',
      signal: controller.signal
    })
  );
});

test('queryOptions forwards TanStack Query cancellation to the listener request', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(homeResponse, 200, 'listener-1'));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await expect(queryClient.fetchQuery(listenerHomeQuery('listener-1'))).resolves.toEqual(homeResponse);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/listener/v1/home',
    expect.objectContaining({
      credentials: 'same-origin',
      signal: expect.any(AbortSignal)
    })
  );
});

test('builds a normalized safe Listener Library request', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
    { items: [], nextCursor: null },
    200,
    'viewer-1'
  ));
  vi.stubGlobal('fetch', fetchMock);

  await getLibraryPage('viewer-1', {
    contentTypes: ['audioTrack', 'album', 'album'],
    sort: 'recentlyPlayed',
    limit: 500,
    cursor: ' next-page '
  });

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/listener/v1/library?sort=recentlyPlayed&limit=100&types=album%2CaudioTrack&cursor=next-page',
    expect.objectContaining({ credentials: 'same-origin' })
  );
});

test('scopes Grid/List pagination to the parent page and current viewer', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    const isLibrary = path.includes('/pages/library/');
    return jsonResponse({
      ...collectionResponse,
      pageItem: {
        ...collectionResponse.pageItem,
        id: path.includes('private-item') ? 'private-item' : 'page-item-1',
        pageSlug: isLibrary ? 'library' : 'home'
      }
    }, 200, path.includes('private-item') ? 'viewer-1' : undefined);
  });
  vi.stubGlobal('fetch', fetchMock);

  await getListenerCollectionPage('home', 'page-item-1', null, {
    limit: 999,
    cursor: ' next-page '
  });
  await getListenerCollectionPage('library', 'private-item', 'viewer-1', {
    limit: 0,
    cursor: '   '
  });

  expect(fetchMock.mock.calls.map(([path, init]) => [
    path,
    new Headers(init?.headers).get('X-Finitude-Account-Viewer')
  ])).toEqual([
    ['/api/listener/v1/pages/home/items/page-item-1?limit=100&cursor=next-page', null],
    ['/api/listener/v1/pages/library/items/private-item?limit=1', 'viewer-1']
  ]);
});

test('rejects a Grid/List response for a different parent identity', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    ...collectionResponse,
    pageItem: { ...collectionResponse.pageItem, id: 'other-item' }
  })));

  await expect(getListenerCollectionPage('home', 'page-item-1')).rejects.toMatchObject({
    kind: 'invalid-response'
  });
});

test('types save status, save, unsave, and recent activity mutations', async () => {
  const target = { contentType: 'audioTrack' as const, contentId: 'track-1' };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/status')) {
      return jsonResponse({ items: [{ ...target, saved: true }] }, 200, 'viewer-1');
    }
    if (path.endsWith('/recently-played')) {
      return jsonResponse({ ...target, recorded: true }, 200, 'viewer-1');
    }
    return jsonResponse({ ...target, saved: init?.method === 'PUT' }, 200, 'viewer-1');
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(getSaveStatuses('viewer-1', [target])).resolves.toEqual({ items: [{ ...target, saved: true }] });
  await expect(saveContent('viewer-1', target)).resolves.toEqual({ ...target, saved: true });
  await expect(unsaveContent('viewer-1', target)).resolves.toEqual({ ...target, saved: false });
  await expect(recordRecentlyPlayed(target, 'viewer-1')).resolves.toEqual({ ...target, recorded: true });

  expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
    ['/content/me/saves/status', 'POST'],
    ['/content/me/saves/audioTrack/track-1', 'PUT'],
    ['/content/me/saves/audioTrack/track-1', 'DELETE'],
    ['/content/me/recently-played', 'POST']
  ]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(new Headers(init?.headers).get('X-Finitude-Account-Viewer')).toBe('viewer-1');
  }
});
