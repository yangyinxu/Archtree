import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { browserSessionQueryKey } from '../../api/session';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { sampleArtworkTone } from '../../artwork/artworkTone';
import { neutralArtworkTone } from '../../artwork/useArtworkTone';
import { PlaylistDetailPage } from './PlaylistDetailPage';

vi.mock('../../artwork/artworkTone', () => ({ sampleArtworkTone: vi.fn() }));

const sample = vi.mocked(sampleArtworkTone);
const tone = { hero: '#2f7a5f', pane: '#1f5440' };
const session = {
  user: {
    id: 'viewer-1',
    email: 'listener@example.com',
    role: 'user',
    displayName: 'Listener',
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
};
const track = {
  contentType: 'audioTrack',
  id: 'track-1',
  title: 'Night',
  artworkUrl: '',
  artistNames: ['Finite Ensemble'],
  albumId: null,
  albumTitle: null,
  duration: '3:00',
  mediaType: 'audio',
  streamUrl: '/content/mediaTrack/stream/track-1'
};
const detail = (artworkUrl: string) => ({
  id: 'playlist-1',
  name: 'Quiet sequence',
  itemCount: 1,
  artworkUrl,
  revision: 1,
  createdAt: '2026-08-04T12:00:00.000Z',
  updatedAt: '2026-08-04T12:05:00.000Z',
  items: [{ itemId: 'item-1', audioTrackId: track.id, addedAt: '2026-08-04T12:01:00.000Z', availability: 'ready', audioTrack: track }]
});

const mount = (artworkUrl: string) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail(artworkUrl)), {
    headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-1' }
  })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, session);
  client.setQueryData(listenerCapabilitiesQueryKey, { playlists: true });
  const main = document.createElement('main');
  main.id = 'main-content';
  document.body.append(main);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/playlists/playlist-1']}>
        <Routes><Route element={<PlaylistDetailPage />} path="/playlists/:playlistId" /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { container: main }
  );
  return { paneTone: () => main.style.getPropertyValue('--tone-color'), ...view };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('Playlist detail tints the main pane with its artwork pane tone and clears it on leave', async () => {
  let finish!: (value: typeof tone) => void;
  sample.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const artwork = '/content/images/0000000000000000000000b7';
  const { paneTone, unmount } = mount(artwork);

  await screen.findByRole('heading', { level: 1, name: 'Quiet sequence' });
  expect(paneTone()).toBe(neutralArtworkTone.pane);
  await waitFor(() => expect(sample).toHaveBeenCalledWith(`${artwork}/v1/96.webp`));
  await act(async () => finish(tone));
  expect(paneTone()).toBe(tone.pane);

  unmount();
  expect(paneTone()).toBe('');
});

test('Playlist detail without managed artwork keeps the neutral pane tone', async () => {
  const { paneTone } = mount('');
  await screen.findByRole('heading', { level: 1, name: 'Quiet sequence' });
  expect(paneTone()).toBe(neutralArtworkTone.pane);
  expect(sample).not.toHaveBeenCalled();
});
