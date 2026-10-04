import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FriendsListening } from './FriendsListening';
const mocks = vi.hoisted(() => ({ friends: vi.fn(), clock: vi.fn(), refresh: vi.fn() }));
vi.mock('../../api/listening', () => ({ getListeningFriends: mocks.friends }));
vi.mock('./listeningSession', () => ({ listeningSession: { getClock: mocks.clock, refresh: mocks.refresh } }));
vi.mock('./InviteListeningFriend', () => ({ InviteListeningFriend: ({ item }: { item: { peer: { alias: string } } }) => <button data-peer-alias={item.peer.alias}>Explicit invitation</button> }));
const socialId = `s_${'a'.repeat(32)}`;
const profile = { socialId, alias: 'Current Alice', handle: 'alice', iconSeed: 'alice' };
const item = (peer = profile, title = 'Fresh Audio') => ({ peer, track: { id: 'a'.repeat(24), contentType: 'audioTrack', title, artistNames: ['Artist'],
  artworkUrl: '/artwork/fresh.webp' }, expiresAtMs: 125_000 });
const peer = (index: number) => ({ socialId: `s_${index.toString(16).padStart(32, '0')}`, alias: `Friend ${index}`, handle: `friend${index}`, iconSeed: `friend${index}` });
const show = (viewer = 'viewer-1') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (id = viewer) => <QueryClientProvider client={client}><FriendsListening key={id} viewerId={id} /></QueryClientProvider>;
  const view = render(content()); return { client, ...view, switchTo: (id: string) => view.rerender(content(id)) };
};
beforeEach(() => {
  vi.clearAllMocks(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mocks.clock.mockImplementation(() => ({ server: 100_000, mono: performance.now() }));
  mocks.refresh.mockResolvedValue(true);
  mocks.friends.mockResolvedValue({ items: [item()], nextCursor: null });
});
test('reads listening friends from the server without sending friend IDs and shows their current card and artwork', async () => {
  show(); expect(await screen.findByText('Current Alice is listening')).toBeInTheDocument();
  expect(mocks.friends).toHaveBeenCalledExactlyOnceWith('viewer-1', undefined, expect.any(AbortSignal));
  const row = screen.getByRole('listitem');
  expect(within(row).getByText('Artist')).toBeInTheDocument();
  expect(row.querySelector('img')).toHaveAttribute('alt', '');
  expect(await screen.findByRole('button', { name: 'Explicit invitation' })).toHaveAttribute('data-peer-alias', 'Current Alice');
});
test('a later read updates the nickname and invitation', async () => {
  show(); await screen.findByText('Current Alice is listening');
  mocks.friends.mockResolvedValue({ items: [item({ ...profile, alias: 'Renamed Alice' })], nextCursor: null });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh listening status' }));
  expect(await screen.findByText('Renamed Alice is listening')).toBeInTheDocument();
  expect(screen.queryByText('Current Alice is listening')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Explicit invitation' })).toHaveAttribute('data-peer-alias', 'Renamed Alice');
  expect(mocks.friends).toHaveBeenCalledTimes(2);
});
test('read failure hides cached private metadata and invitation controls', async () => {
  const { client } = show(); await screen.findByText('Fresh Audio'); mocks.friends.mockRejectedValue(new Error('unavailable'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'listening-friends'] }); });
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument());
  expect(screen.getByRole('alert')).toHaveTextContent('We could not complete that action. Try again.');
  expect(screen.queryByRole('button', { name: 'Explicit invitation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});
test('a removed friend disappears on the next read and account changes discard cached statuses immediately', async () => {
  const { client, switchTo } = show(); await screen.findByText('Fresh Audio');
  mocks.friends.mockResolvedValue({ items: [], nextCursor: null });
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1'] }); });
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument());
  mocks.friends.mockReturnValue(new Promise(() => undefined)); switchTo('viewer-2'); expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument();
});
test('hidden document stops polling and hides status', async () => {
  show(); await screen.findByText('Fresh Audio'); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Refresh listening status' })).toBeDisabled();
});
test('status expires locally before the next server poll', async () => {
  mocks.friends.mockResolvedValue({ items: [{ ...item(), expiresAtMs: 100_100 }], nextCursor: null }); show(); await screen.findByText('Fresh Audio');
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument(), { timeout: 1000 }); expect(mocks.friends).toHaveBeenCalledTimes(1);
});
test('friends listening beyond the first page appear after Load more and every loaded page refreshes together', async () => {
  const first = Array.from({ length: 20 }, (_, index) => item(peer(index + 1), `Song ${index + 1}`));
  const later = item(peer(21), 'Song 21');
  mocks.friends.mockImplementation(async (_viewer: string, cursor?: string) => cursor === 'page-two'
    ? { items: [later, first[19]], nextCursor: null } : { items: first, nextCursor: 'page-two' });
  show(); await screen.findByText('Friend 1 is listening');
  expect(screen.queryByText('Friend 21 is listening')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Friend 21 is listening')).toBeInTheDocument();
  expect(mocks.friends).toHaveBeenLastCalledWith('viewer-1', 'page-two', expect.any(AbortSignal));
  // A friend who moved between pages during the sequential reads is shown once.
  expect(screen.getAllByText('Friend 20 is listening')).toHaveLength(1);
  expect(screen.getAllByRole('listitem')).toHaveLength(21);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  mocks.friends.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh listening status' }));
  await waitFor(() => expect(mocks.friends).toHaveBeenCalledTimes(2));
  expect(mocks.friends.mock.calls.map(call => call[1])).toEqual([undefined, 'page-two']);
});
test('repeated explicit refreshes reuse the owner clock', async () => {
  show(); await screen.findByText('Fresh Audio');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh listening status' })); await waitFor(() => expect(mocks.friends).toHaveBeenCalledTimes(2));
  expect(mocks.refresh).not.toHaveBeenCalled();
});
test('a missing owner clock is refreshed first and an unavailable clock fails closed', async () => {
  mocks.clock.mockReturnValue(null); show();
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that action. Try again.');
  expect(mocks.refresh).toHaveBeenCalledOnce(); expect(mocks.friends).not.toHaveBeenCalled();
});
