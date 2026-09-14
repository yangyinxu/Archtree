import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FriendsListening } from './FriendsListening';
const mocks = vi.hoisted(() => ({ friends: vi.fn(), statuses: vi.fn(), clock: vi.fn(), refresh: vi.fn() }));
vi.mock('../../api/social', () => ({ getSocialPage: mocks.friends }));
vi.mock('../../api/listening', () => ({ getListeningStatuses: mocks.statuses }));
vi.mock('./listeningSession', () => ({ listeningSession: { getClock: mocks.clock, refresh: mocks.refresh } }));
vi.mock('./InviteListeningFriend', () => ({ InviteListeningFriend: ({ item }: { item: { peer: { alias: string } } }) => <button data-peer-alias={item.peer.alias}>Explicit invitation</button> }));
const socialId = `s_${'a'.repeat(32)}`;
const profile = { socialId, alias: 'Current Alice', handle: 'alice', iconSeed: 'alice' };
const item = () => ({ peer: profile, track: { id: 'a'.repeat(24), contentType: 'audioTrack', title: 'Fresh Audio', artistNames: [], artworkUrl: '' }, expiresAtMs: 125_000 });
const show = (viewer = 'viewer-1') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (id = viewer) => <QueryClientProvider client={client}><FriendsListening key={id} viewerId={id} /></QueryClientProvider>;
  const view = render(content()); return { client, ...view, switchTo: (id: string) => view.rerender(content(id)) };
};
beforeEach(() => {
  vi.clearAllMocks(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mocks.friends.mockResolvedValue({ items: [{ socialId, profile: { ...profile, alias: 'Old Alice' }, revision: 1 }], nextCursor: null });
  mocks.clock.mockImplementation(() => ({ server: 100_000, mono: performance.now() }));
  mocks.refresh.mockResolvedValue(true);
  mocks.statuses.mockResolvedValue({ items: [item()] });
});
test('queries only observed friends and uses the status response identity over an older friend page', async () => {
  show(); expect(await screen.findByText('Current Alice is listening')).toBeInTheDocument();
  expect(screen.queryByText('Old Alice is listening')).not.toBeInTheDocument();
  expect(mocks.statuses).toHaveBeenCalledWith('viewer-1', [socialId], expect.any(AbortSignal));
  expect(await screen.findByRole('button', { name: 'Explicit invitation' })).toHaveAttribute('data-peer-alias', 'Current Alice');
});
test('a later status response updates the nickname and invitation while the friend page remains cached', async () => {
  show(); await screen.findByText('Current Alice is listening');
  mocks.statuses.mockResolvedValue({ items: [{ ...item(), peer: { ...profile, alias: 'Renamed Alice' } }] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh listening status' }));
  expect(await screen.findByText('Renamed Alice is listening')).toBeInTheDocument();
  expect(screen.queryByText('Current Alice is listening')).not.toBeInTheDocument();
  expect(screen.queryByText('Old Alice is listening')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Explicit invitation' })).toHaveAttribute('data-peer-alias', 'Renamed Alice');
  expect(mocks.friends).toHaveBeenCalledTimes(1); expect(mocks.statuses).toHaveBeenCalledTimes(2);
});
test('read failure hides cached private metadata and invitation controls', async () => {
  const { client } = show(); await screen.findByText('Fresh Audio'); mocks.statuses.mockRejectedValue(new Error('unavailable'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'listening-status'] }); });
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument()); expect(screen.queryByRole('button', { name: 'Explicit invitation' })).not.toBeInTheDocument();
});
test('friend removal and account changes discard matching cached statuses immediately', async () => {
  const { client, switchTo } = show(); await screen.findByText('Fresh Audio');
  await act(async () => { client.setQueryData(['social', 'viewer-1', 'relationships', 'friends', 'listening-page', undefined], { items: [], nextCursor: null }); });
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument());
  mocks.friends.mockReturnValue(new Promise(() => undefined)); switchTo('viewer-2'); expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument();
});
test('hidden document stops polling and hides status', async () => {
  show(); await screen.findByText('Fresh Audio'); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Refresh listening status' })).toBeDisabled();
});
test('status expires locally before the next server poll', async () => {
  mocks.statuses.mockResolvedValue({ items: [{ ...item(), expiresAtMs: 100_100 }] }); show(); await screen.findByText('Fresh Audio');
  await waitFor(() => expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument(), { timeout: 1000 }); expect(mocks.statuses).toHaveBeenCalledTimes(1);
});
test('next page replaces the queried friend set rather than accumulating recurring reads', async () => {
  const nextId = `s_${'b'.repeat(32)}`;
  mocks.friends.mockResolvedValueOnce({ items: [{ socialId, profile, revision: 1 }], nextCursor: 'page-two' })
    .mockResolvedValue({ items: [{ socialId: nextId, profile: { ...profile, socialId: nextId, alias: 'Bob' }, revision: 1 }], nextCursor: null });
  mocks.statuses.mockImplementation(async (_viewer, ids) => ({ items: ids[0] === socialId ? [item()] : [] })); show(); await screen.findByText('Fresh Audio');
  fireEvent.click(screen.getByRole('button', { name: 'Show next items in Listening with friends' }));
  await waitFor(() => expect(mocks.statuses).toHaveBeenCalledWith('viewer-1', [nextId], expect.any(AbortSignal))); expect(screen.queryByText('Fresh Audio')).not.toBeInTheDocument();
});

test('repeated explicit status refreshes reuse the owner clock and a fresh friendship page', async () => {
  show(); await screen.findByText('Fresh Audio');
  const refresh = screen.getByRole('button', { name: 'Refresh listening status' });
  fireEvent.click(refresh); await waitFor(() => expect(mocks.statuses).toHaveBeenCalledTimes(2));
  expect(mocks.friends).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled();
});
