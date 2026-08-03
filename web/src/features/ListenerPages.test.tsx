import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../api/session';
import { playerStore } from '../player';
import { AlbumPage } from './catalog/AlbumPage';
import { LibraryPage } from './library/LibraryPage';
import { SearchPage } from './search/SearchPage';

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
  streamUrl: `/content/audioTrack/stream/64b000000000000000000002`
} as const;

const artist = {
  contentType: 'artist',
  id: '64b000000000000000000003',
  name: 'Finite Ensemble',
  bio: '',
  artworkUrl: ''
} as const;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const renderRoute = (
  path: string,
  routePath: string,
  element: ReactNode,
  session: unknown = null
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, session);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={element} path={routePath} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
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
});

test('Search renders grouped public results and keeps content actions canonical', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    query: 'Night',
    artists: [artist],
    albums: [album],
    audioTracks: [track]
  })));
  renderRoute('/search?q=Night', '/search', <SearchPage />);

  expect(await screen.findByRole('heading', { name: 'Artists' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Albums' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Soundtracks' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Finite Ensemble, artist' })).toHaveAttribute(
    'href',
    `/artists/${artist.id}`
  );
  expect(screen.getByRole('button', { name: 'Play Blue Interval by Finite Ensemble' })).toBeInTheDocument();
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
            available: true,
            streamUrl: track.streamUrl
          }
        }];
    return jsonResponse({ items, nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderRoute('/library', '/library', <LibraryPage />, {
    user: {
      id: 'listener-1',
      email: 'listener@example.com',
      role: 'user',
      displayName: 'Listener',
      avatarRevision: 0,
      avatar: null,
      emailVerified: true
    }
  });

  expect(await screen.findByRole('button', { name: 'Play Blue Interval by Finite Ensemble' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Downloads' })).not.toBeInTheDocument();
  expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Albums' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('types=album'))).toBe(true));
  expect(await screen.findByRole('link', { name: 'Night Geometry, album' })).toBeInTheDocument();
});
