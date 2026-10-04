import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { browserSessionQueryKey } from '../../api/session';
import { playlistQueryKeys, type PlaylistDetail } from '../../api/playlists';
import { PlaylistDetailPage } from './PlaylistDetailPage';

const viewerId = 'viewer-1';
const session = { user: { id: viewerId, email: 'listener@example.com', role: 'user', displayName: 'Listener', avatarRevision: 0, avatar: null, emailVerified: true } };
const first: PlaylistDetail = {
  id: 'playlist-a', name: 'Playlist A', itemCount: 2, artworkUrl: '', revision: 3,
  createdAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:00.000Z',
  items: ['Night', 'Dawn'].map((title, index) => ({
    itemId: `item-${index}`, audioTrackId: `track-${index}`, addedAt: '2026-08-04T12:00:00.000Z', availability: 'ready',
    audioTrack: { contentType: 'audioTrack', id: `track-${index}`, title, artworkUrl: '', artistNames: ['Artist'],
      albumId: null, albumTitle: null, duration: '3:00', mediaType: 'audio', streamUrl: `/content/mediaTrack/stream/track-${index}` }
  }))
};
const second: PlaylistDetail = { ...first, id: 'playlist-b', name: 'Playlist B' };
const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': viewerId }
});

/** Exposes real route reuse and a deferred HTTP write, the two boundaries that caused the regression. */
const mount = () => {
  let finish!: (response: Response) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; });
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' || init?.method === 'DELETE') { writes.push(url); return pending; }
    return Promise.resolve(response(url.includes('playlist-b') ? second : first));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(browserSessionQueryKey, session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/playlists/playlist-a']}>
    <Link to="/playlists/playlist-a">Open A</Link><Link to="/playlists/playlist-b">Open B</Link>
    <Routes><Route path="/playlists/:playlistId" element={<PlaylistDetailPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  return { client, writes, finish, fail };
};
const change = async (user: ReturnType<typeof userEvent.setup>, kind: 'reorder' | 'remove') => {
  await user.click(await screen.findByRole('button', { name: 'Actions for Dawn' }));
  await user.click(screen.getByRole('menuitem', { name: kind === 'reorder' ? 'Move Up' : 'Remove from Playlist' }));
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(['reorder', 'remove'] as const)('a failed %s on A cannot replace B or announce an error on B', async (kind) => {
  const user = userEvent.setup();
  const { client, writes, fail } = mount();
  await screen.findByRole('heading', { name: first.name });
  await change(user, kind);
  await waitFor(() => expect(writes).toHaveLength(1));
  await user.click(screen.getByRole('link', { name: 'Open B' }));
  await screen.findByRole('heading', { name: second.name });
  await act(async () => fail(new Error('connection lost')));
  await waitFor(() => expect(client.getQueryData(playlistQueryKeys.detail(viewerId, first.id))).toEqual(first));
  expect(client.getQueryData(playlistQueryKeys.detail(viewerId, second.id))).toEqual(second);
  expect(screen.getByRole('heading', { name: second.name })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('route navigation while cancellation is pending cannot retarget the dispatched write', async () => {
  const user = userEvent.setup();
  const { client, writes, finish } = mount();
  await screen.findByRole('heading', { name: first.name });
  let release!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await change(user, 'reorder');
  await user.click(screen.getByRole('link', { name: 'Open B' }));
  await screen.findByRole('heading', { name: second.name });
  await act(async () => release());
  await waitFor(() => expect(writes).toEqual(['/content/me/playlists/playlist-a/items/order']));
  await act(async () => finish(response({ ...first, revision: 4, items: [...first.items].reverse() })));
  expect(client.getQueryData(playlistQueryKeys.detail(viewerId, second.id))).toEqual(second);
  expect(screen.queryByText('Move was not saved.')).not.toBeInTheDocument();
});

test.each(['failure', 'success'] as const)('a late %s cannot overwrite a newer resource revision', async (outcome) => {
  const user = userEvent.setup();
  const { client, writes, fail, finish } = mount();
  await screen.findByRole('heading', { name: first.name });
  await change(user, 'reorder');
  await waitFor(() => expect(writes).toHaveLength(1));
  const latest = { ...first, name: 'Latest confirmed Playlist', revision: 5 };
  await act(async () => {
    client.setQueryData(playlistQueryKeys.detail(viewerId, first.id), latest);
    if (outcome === 'failure') fail(new Error('connection lost'));
    else finish(response({ ...first, revision: 4, items: [...first.items].reverse() }));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled());
  expect(client.getQueryData(playlistQueryKeys.detail(viewerId, first.id))).toEqual(latest);
  expect(screen.getByRole('heading', { name: latest.name })).toBeInTheDocument();
});

test('a later confirmed read with the same optimistic values still supersedes rollback ownership', async () => {
  const user = userEvent.setup();
  const { client, writes, fail } = mount();
  await screen.findByRole('heading', { name: first.name });
  await change(user, 'reorder');
  await waitFor(() => expect(writes).toHaveLength(1));
  const key = playlistQueryKeys.detail(viewerId, first.id);
  const confirmed = structuredClone(client.getQueryData<PlaylistDetail>(key)!);
  await act(async () => { client.setQueryData(key, confirmed); fail(new Error('connection lost')); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled());
  expect(client.getQueryData(key)).toEqual(confirmed);
});

test.each(['failure', 'success'] as const)('a late %s cannot restore private cache after an account transition', async (outcome) => {
  const user = userEvent.setup();
  const { client, writes, fail, finish } = mount();
  await screen.findByRole('heading', { name: first.name });
  await change(user, 'reorder');
  await waitFor(() => expect(writes).toHaveLength(1));
  await act(async () => {
    advanceAccountEpoch();
    client.setQueryData(browserSessionQueryKey, null);
    client.removeQueries({ queryKey: ['listener', 'playlist', viewerId] });
    if (outcome === 'failure') fail(new Error('connection lost'));
    else finish(response({ ...first, revision: 4 }));
  });
  expect(client.getQueriesData({ queryKey: ['listener', 'playlist', viewerId] })).toEqual([]);
  await waitFor(() => expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument());
});


test('an older failed reorder cannot roll back a newer completed removal after revisiting the route', async () => {
  const user = userEvent.setup();
  const { client, writes, fail } = mount();
  await screen.findByRole('heading', { name: first.name });
  await change(user, 'reorder');
  await waitFor(() => expect(writes).toHaveLength(1));
  await user.click(screen.getByRole('link', { name: 'Open B' }));
  await screen.findByRole('heading', { name: second.name });
  await user.click(screen.getByRole('link', { name: 'Open A' }));
  await screen.findByRole('heading', { name: first.name });
  const latest = { ...first, revision: 5, itemCount: 1, items: [first.items[0]] };
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => init?.method === 'DELETE'
    ? Promise.resolve(response(latest)) : originalFetch(input, init));
  await change(user, 'remove');
  await waitFor(() => expect(client.getQueryData(playlistQueryKeys.detail(viewerId, first.id))).toEqual(latest));
  await act(async () => fail(new Error('old reorder failed')));
  expect(client.getQueryData(playlistQueryKeys.detail(viewerId, first.id))).toEqual(latest);
  expect(screen.queryByText('Move was not saved.')).not.toBeInTheDocument();
});

test('an account change while preparing an optimistic mutation prevents dispatch', async () => {
  const user = userEvent.setup();
  const { client, writes } = mount();
  await screen.findByRole('heading', { name: first.name });
  let release!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await change(user, 'reorder');
  await act(async () => {
    advanceAccountEpoch();
    client.setQueryData(browserSessionQueryKey, null);
    client.removeQueries({ queryKey: ['listener', 'playlist', viewerId] });
    release();
  });
  await waitFor(() => expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument());
  expect(writes).toEqual([]);
  expect(client.getQueriesData({ queryKey: ['listener', 'playlist', viewerId] })).toEqual([]);
});
