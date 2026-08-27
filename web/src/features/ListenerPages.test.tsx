import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../api/session';
import { advanceAccountEpoch } from '../api/accountEpoch';
import { listenerCapabilitiesQueryKey } from '../api/listenerCapabilities';
import { playerStore } from '../player';
import { AlbumPage } from './catalog/AlbumPage';
import { OrganizationPage } from './catalog/OrganizationPage';
import { LibraryPage } from './library/LibraryPage';
import { SearchQueryProvider } from './search/SearchQueryProvider';
import { SearchPage } from './search/SearchPage';
import { readSearchHistory, rememberSearchQuery } from './search/searchHistory';

const album = {
  contentType: 'album',
  id: '64b000000000000000000001',
  title: 'Night Geometry',
  artworkUrl: '/content/images/0123456789abcdef01234567',
  artistNames: ['Finite Ensemble'],
  releaseDate: { year: 2026 }
} as const;

const track = {
  contentType: 'audioTrack',
  id: '64b000000000000000000002',
  title: 'Blue Interval',
  artworkUrl: '',
  artistNames: ['Finite Ensemble'],
  albumId: album.id,
  albumTitle: album.title,
  duration: '3:24',
  mediaType: 'audio',
  streamUrl: `/content/mediaTrack/stream/64b000000000000000000002`
} as const;

const artist = {
  contentType: 'artist',
  id: '64b000000000000000000003',
  name: 'Finite Ensemble',
  bio: '',
  artworkUrl: ''
} as const;

const organization = {
  contentType: 'organization',
  id: '64b000000000000000000004',
  name: 'Finite Records',
  organizationType: 'label',
  description: 'Independent releases.'
} as const;

const listenerSession = {
  user: {
    id: 'listener-1',
    email: 'listener@example.com',
    role: 'user',
    displayName: 'Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
};

const unresolvedSession = Symbol('unresolved browser session');

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'X-Finitude-Account-Viewer': 'listener-1'
  }
});

const waitForSearchDebounce = () => act(async () => {
  await new Promise((resolve) => window.setTimeout(resolve, 350));
});

const renderRoute = (
  path: string,
  routePath: string,
  element: ReactNode,
  session: unknown = null
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
  if (session !== unresolvedSession) queryClient.setQueryData(browserSessionQueryKey, session);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            element={<SearchQueryProvider>{element}</SearchQueryProvider>}
            path={routePath}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { queryClient, ...view };
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

test('Album Play and explicit soundtrack selection share the ordered Album queue', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ album, tracks: [track] })));
  const launch = vi.spyOn(playerStore, 'launchAlbumQueue').mockResolvedValue();
  renderRoute(`/albums/${album.id}`, '/albums/:albumId', <AlbumPage />);

  expect(await screen.findByRole('heading', { name: 'Night Geometry' })).toBeInTheDocument();
  const heroArtwork = screen.getByRole('img', { name: 'Night Geometry cover' });
  expect(heroArtwork).toHaveAttribute('loading', 'eager');
  expect(heroArtwork).toHaveAttribute('fetchpriority', 'high');
  expect(heroArtwork).toHaveAttribute(
    'sizes',
    '(max-width: 520px) 12rem, (max-width: 720px) 10rem, 20rem'
  );
  await user.click(screen.getByRole('button', { name: 'Play' }));
  expect(launch).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: track.id, streamUrl: track.streamUrl })
  ], 0);

  await user.click(screen.getByRole('button', { name: 'Play Blue Interval' }));
  expect(launch).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: track.id })
  ], 0);

  await user.click(screen.getByRole('button', { name: 'Add Blue Interval to Playlist' }));
  expect(screen.getByRole('dialog', { name: 'Log in to add to a Playlist' })).toBeInTheDocument();
  expect(launch).toHaveBeenCalledTimes(2);
});

test('Album marks the actively playing track and pauses it without relaunching the queue', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ album, tracks: [track] })));
  const snapshot = playerStore.getSnapshot();
  vi.spyOn(playerStore, 'getSnapshot').mockReturnValue({
    ...snapshot,
    currentIndex: 0,
    currentItem: track,
    queue: [track],
    status: 'playing'
  });
  const pause = vi.spyOn(playerStore, 'pause').mockImplementation(() => undefined);
  const launch = vi.spyOn(playerStore, 'launchAlbumQueue').mockResolvedValue();
  renderRoute(`/albums/${album.id}`, '/albums/:albumId', <AlbumPage />);

  const pauseAction = await screen.findByRole('button', { name: 'Pause' });
  const trackRow = pauseAction.closest('li');
  expect(trackRow).toHaveAttribute('data-playback-state', 'playing');
  expect(pauseAction).toHaveAttribute('aria-current', 'true');
  expect(pauseAction.querySelector('.lucide-audio-lines')).toBeInTheDocument();
  expect(pauseAction.querySelector('.lucide-pause')).toBeInTheDocument();
  expect(screen.getByText('Blue Interval').className).toContain('trackTitlePlaying');

  await user.click(pauseAction);

  expect(pause).toHaveBeenCalledOnce();
  expect(launch).not.toHaveBeenCalled();
});

test('Organization page renders its public metadata and credited releases', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    organization: {
      id: organization.id,
      name: organization.name,
      organizationType: organization.organizationType,
      description: organization.description
    },
    releases: [album]
  })));
  renderRoute(
    `/organizations/${organization.id}`,
    '/organizations/:organizationId',
    <OrganizationPage />
  );

  expect(await screen.findByRole('heading', { name: 'Finite Records' })).toBeInTheDocument();
  expect(screen.getByText('Independent releases.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Releases' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Night Geometry, album' })).toBeInTheDocument();
});

test('Search renders grouped public results and keeps content actions canonical', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    query: 'Night',
    artists: [artist],
    organizations: [organization],
    albums: [album],
    audioTracks: [track]
  })));
  renderRoute('/search/?q=Night', '/search', <SearchPage />);

  expect(await screen.findByRole('heading', { name: 'Artists' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Albums' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Organizations' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'MediaTracks' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Finite Ensemble, artist' })).toHaveAttribute(
    'href',
    `/artists/${artist.id}`
  );
  expect(screen.getByRole('link', { name: 'Finite Records, organization' })).toHaveAttribute(
    'href',
    `/organizations/${organization.id}`
  );
  expect(screen.getByRole('button', { name: 'Play Blue Interval by Finite Ensemble' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Add Blue Interval to Playlist' })).toBeInTheDocument();
  expect(readSearchHistory(null)).toEqual([]);
});

test('Search retry refreshes results without adding or reordering history', async () => {
  const user = userEvent.setup();
  rememberSearchQuery(null, 'Prior');
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ message: 'Unavailable' }, 503))
    .mockResolvedValueOnce(jsonResponse({
      query: 'Night',
      artists: [],
      albums: [],
      audioTracks: []
    }));
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/search?q=Night', '/search', <SearchPage />);

  await user.click(await screen.findByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('No artists, organizations, albums, or MediaTracks matched this search.'))
    .toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(readSearchHistory(null)).toEqual(['Prior']);
});

test('Search debounces edited queries without remembering them until explicit submission', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    query: 'Nigh',
    artists: [],
    albums: [],
    audioTracks: []
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/search', '/search', <SearchPage />);

  const input = screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  });
  expect(input).toHaveAttribute('enterkeyhint', 'search');
  expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  await user.type(input, 'Night');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readSearchHistory(null)).toEqual([]);
  await waitForSearchDebounce();

  expect(await screen.findByRole('heading', { name: 'Results for “Night”' })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/listener/v1/search?q=Night',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  expect(readSearchHistory(null)).toEqual([]);

  await user.type(input, '{Backspace}');
  await waitForSearchDebounce();

  expect(await screen.findByRole('heading', { name: 'Results for “Nigh”' })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(readSearchHistory(null)).toEqual([]);

  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(readSearchHistory(null)).toEqual([]);

  await user.keyboard('{Enter}');

  await waitFor(() => expect(readSearchHistory(null)).toEqual(['Nigh']));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/listener/v1/search?q=Nigh',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});

test('Search cancels an in-flight draft request when a newer draft is previewed', async () => {
  const user = userEvent.setup();
  let firstSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('q=Night')) {
      firstSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    return Promise.resolve(jsonResponse({
      query: 'Dawn',
      artists: [],
      albums: [],
      audioTracks: []
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/search', '/search', <SearchPage />);

  const input = screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  });
  await user.type(input, 'Night');
  await waitForSearchDebounce();
  expect(firstSignal).toBeDefined();

  await user.clear(input);
  await user.type(input, 'Dawn');
  await waitForSearchDebounce();

  expect(await screen.findByRole('heading', { name: 'Results for “Dawn”' })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(firstSignal?.aborted).toBe(true);
  expect(readSearchHistory(null)).toEqual([]);
});

test('Search waits for IME composition to finish before previewing or recording', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    query: '夜',
    artists: [],
    albums: [],
    audioTracks: []
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/search', '/search', <SearchPage />);

  const input = screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '夜' } });
  await waitForSearchDebounce();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(readSearchHistory(null)).toEqual([]);

  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
  fireEvent.compositionEnd(input, { data: '夜' });

  expect(await screen.findByRole('heading', { name: 'Results for “夜”' }, {
    timeout: 1_000
  })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(readSearchHistory(null)).toEqual([]);

  await user.click(input);
  await user.keyboard('{Enter}');

  await waitFor(() => expect(readSearchHistory(null)).toEqual(['夜']));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('Search defers history until the pending account identity resolves', async () => {
  const user = userEvent.setup();
  let finishSession!: (response: Response) => void;
  const sessionRequest = new Promise<Response>((resolve) => { finishSession = resolve; });
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === '/auth/browser/session') return sessionRequest;
    return Promise.resolve(jsonResponse({
      query: 'Private search',
      artists: [],
      albums: [],
      audioTracks: []
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = renderRoute('/search', '/search', <SearchPage />, unresolvedSession);

  const input = screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  });
  await user.type(input, 'Private search');
  await user.keyboard('{Enter}');

  expect(await screen.findByRole('heading', {
    name: 'Results for “Private search”'
  })).toBeInTheDocument();
  expect(readSearchHistory(null)).toEqual([]);
  expect(readSearchHistory('listener-1')).toEqual([]);

  view.unmount();
  finishSession(jsonResponse(listenerSession));

  await waitFor(() => expect(readSearchHistory('listener-1')).toEqual(['Private search']));
  expect(readSearchHistory(null)).toEqual([]);
});

test('a pending Search submission cannot write history after the account epoch changes', async () => {
  const user = userEvent.setup();
  let finishSession!: (response: Response) => void;
  const sessionRequest = new Promise<Response>((resolve) => { finishSession = resolve; });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
    String(input) === '/auth/browser/session'
      ? sessionRequest
      : Promise.resolve(jsonResponse({
          query: 'Old account query',
          artists: [],
          albums: [],
          audioTracks: []
        }))
  )));
  const view = renderRoute('/search', '/search', <SearchPage />, unresolvedSession);

  const input = screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  });
  await user.type(input, 'Old account query');
  await user.keyboard('{Enter}');
  advanceAccountEpoch();
  finishSession(jsonResponse(listenerSession));

  await waitFor(() => expect(view.queryClient.getQueryData(browserSessionQueryKey))
    .toEqual(listenerSession));
  expect(readSearchHistory('listener-1')).toEqual([]);
  expect(readSearchHistory(null)).toEqual([]);
});

test('clearing an edited Search draft returns to the default state without a new request', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    query: 'Night',
    artists: [],
    albums: [],
    audioTracks: []
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/search?q=Night', '/search', <SearchPage />);

  expect(await screen.findByRole('heading', { name: 'Results for “Night”' })).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await user.clear(screen.getByRole('searchbox', {
    name: 'Search artists, organizations, albums, and MediaTracks'
  }));

  expect(await screen.findByRole('heading', { name: 'Try a listening mood' }, {
    timeout: 1_000
  })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readSearchHistory(null)).toEqual([]);
});

test('Library sends type filters to the server and retains the mixed saved list', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const items = path.includes('types=album')
      ? [{
          contentType: 'album',
          contentId: album.id,
          savedAt: '2026-08-02T00:00:00.000Z',
          lastPlayedAt: null,
          lastActivityAt: '2026-08-02T00:00:00.000Z',
          creator: 'Finite Ensemble',
          album: {
            _id: album.id,
            title: album.title,
            coverArtUrl: '',
            releaseDate: album.releaseDate
          }
        }]
      : [{
          contentType: 'audioTrack',
          contentId: track.id,
          savedAt: '2026-08-02T00:00:00.000Z',
          lastPlayedAt: null,
          lastActivityAt: '2026-08-02T00:00:00.000Z',
          creator: 'Finite Ensemble',
          audioTrack: {
            _id: track.id,
            title: track.title,
            displayCoverArtUrl: '',
            coverArtUrl: '',
            albumId: album.id,
            duration: track.duration,
            mediaType: 'audio',
            available: true,
            streamUrl: track.streamUrl
          }
        }];
    return jsonResponse({ items, nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/library', '/library', <LibraryPage />, listenerSession);

  expect(await screen.findByRole('button', { name: 'Play Blue Interval by Finite Ensemble' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Add Blue Interval to Playlist' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Downloads' })).not.toBeInTheDocument();
  expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Albums' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('types=album'))).toBe(true));
  expect(await screen.findByRole('link', { name: 'Night Geometry, album' })).toBeInTheDocument();
});
