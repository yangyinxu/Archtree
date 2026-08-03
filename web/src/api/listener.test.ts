import { QueryClient } from '@tanstack/react-query';

import {
  getLibraryPage,
  getSaveStatuses,
  listenerHomeQuery,
  recordRecentlyPlayed,
  saveContent,
  unsaveContent
} from './listener';

const homeResponse = { title: 'Home', sections: [] };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

test('queryOptions forwards TanStack Query cancellation to the listener request', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(homeResponse));
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
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);

  await getLibraryPage({
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

test('types save status, save, unsave, and recent activity mutations', async () => {
  const target = { contentType: 'audioTrack' as const, contentId: 'track-1' };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/status')) {
      return jsonResponse({ items: [{ ...target, saved: true }] });
    }
    if (path.endsWith('/recently-played')) {
      return jsonResponse({ ...target, recorded: true });
    }
    return jsonResponse({ ...target, saved: init?.method === 'PUT' });
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(getSaveStatuses([target])).resolves.toEqual({ items: [{ ...target, saved: true }] });
  await expect(saveContent(target)).resolves.toEqual({ ...target, saved: true });
  await expect(unsaveContent(target)).resolves.toEqual({ ...target, saved: false });
  await expect(recordRecentlyPlayed(target)).resolves.toEqual({ ...target, recorded: true });

  expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
    ['/content/me/saves/status', 'POST'],
    ['/content/me/saves/audioTrack/track-1', 'PUT'],
    ['/content/me/saves/audioTrack/track-1', 'DELETE'],
    ['/content/me/recently-played', 'POST']
  ]);
});
