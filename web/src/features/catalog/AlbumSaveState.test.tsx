import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { browserSessionQueryKey } from '../../api/session';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { AlbumPage } from './AlbumPage';

const viewerId = 'viewer-1';
const session = { user: { id: viewerId, email: 'listener@example.com', role: 'user', displayName: 'Listener', avatarRevision: 0, avatar: null, emailVerified: true } };
const album = { contentType: 'album', id: 'album-1', title: 'Large Album', artworkUrl: '', artistNames: ['Artist'], releaseDate: null };
const tracks = (count: number) => Array.from({ length: count }, (_, index) => ({
  contentType: 'audioTrack', id: `track-${index}`, title: `Track ${index}`, artworkUrl: '', artistNames: ['Artist'],
  albumId: album.id, albumTitle: album.title, duration: '3:00', mediaType: 'audio', streamUrl: `/content/mediaTrack/stream/track-${index}`
}));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewerId }
});

/** Keeps account bootstrap out of the test while exercising the real Album and Save request boundaries. */
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(browserSessionQueryKey, session);
  client.setQueryData(listenerCapabilitiesQueryKey, { playlists: false });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/albums/album-1']}>
    <Routes><Route path="/albums/:albumId" element={<AlbumPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  return client;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each([99, 100, 101])('enables all Save controls for an Album with %i tracks using bounded batches', async (count) => {
  const sizes: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/saves/status')) {
      const { items } = JSON.parse(String(init?.body));
      sizes.push(items.length);
      return response({ items: items.map((item: object) => ({ ...item, saved: false })) });
    }
    return response({ album, tracks: tracks(count) });
  }));
  mount();
  await screen.findByRole('heading', { name: album.title });
  await waitFor(() => {
    const buttons = screen.getAllByRole('button', { name: 'Save to Library' });
    expect(buttons).toHaveLength(count + 1);
    buttons.forEach((button) => expect(button).toHaveAttribute('aria-disabled', 'false'));
  });
  expect(sizes).toEqual(count === 99 ? [100] : [100, count - 99]);
});

test('uses newer server Save state after a confirmed local mutation', async () => {
  const user = userEvent.setup();
  let saved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/saves/status')) {
      const { items } = JSON.parse(String(init?.body));
      return response({ items: items.map((item: { contentType: string }) => ({ ...item, saved: item.contentType === 'album' && saved })) });
    }
    if (init?.method === 'PUT') { saved = true; return response({ contentType: 'album', contentId: album.id, saved }); }
    return response({ album, tracks: tracks(1) });
  }));
  const client = mount();
  await screen.findByRole('heading', { name: album.title });
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save to Library' })[0]).toHaveAttribute('aria-disabled', 'false'));
  await user.click(screen.getAllByRole('button', { name: 'Save to Library' })[0]);
  await screen.findByRole('button', { name: 'Remove from Library' });
  // Another client changes the same item; a focus/refetch must become authoritative.
  saved = false;
  await act(async () => { await client.invalidateQueries({ queryKey: ['listener', 'save-statuses'] }); });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove from Library' })).not.toBeInTheDocument());
  expect(screen.getAllByRole('button', { name: 'Save to Library' })).toHaveLength(2);
});

test('shows recovery after a later Save batch fails and enables controls only after complete retry', async () => {
  const user = userEvent.setup();
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/saves/status')) return response({ album, tracks: tracks(100) });
    const { items } = JSON.parse(String(init?.body));
    return items.length === 1 && fail ? response({}, 503)
      : response({ items: items.map((item: object) => ({ ...item, saved: false })) });
  }));
  mount();
  await screen.findByRole('alert');
  screen.getAllByRole('button', { name: 'Save to Library' }).forEach((button) => expect(button).toHaveAttribute('aria-disabled', 'true'));
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  screen.getAllByRole('button', { name: 'Save to Library' }).forEach((button) => expect(button).toHaveAttribute('aria-disabled', 'false'));
});

test('a late Save response cannot restore state after an account transition', async () => {
  const user = userEvent.setup();
  let finish!: (result: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finish = resolve; });
    if (url.endsWith('/saves/status')) {
      const { items } = JSON.parse(String(init?.body));
      return Promise.resolve(response({ items: items.map((item: object) => ({ ...item, saved: false })) }));
    }
    return Promise.resolve(response({ album, tracks: tracks(1) }));
  }));
  const client = mount();
  await screen.findByRole('heading', { name: album.title });
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save to Library' })[0]).toHaveAttribute('aria-disabled', 'false'));
  await user.click(screen.getAllByRole('button', { name: 'Save to Library' })[0]);
  await act(async () => {
    advanceAccountEpoch();
    client.setQueryData(browserSessionQueryKey, null);
    client.removeQueries({ queryKey: ['listener', 'save-statuses', viewerId] });
    finish(response({ contentType: 'album', contentId: album.id, saved: true }));
  });
  expect(client.getQueriesData({ queryKey: ['listener', 'save-statuses', viewerId] })).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Remove from Library' })).not.toBeInTheDocument();
});
