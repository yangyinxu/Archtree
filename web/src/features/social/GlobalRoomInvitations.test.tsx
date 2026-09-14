import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomInvitation } from '../../api/rooms';
import { GlobalRoomInvitations } from './GlobalRoomInvitations';
import { roomFixture } from '../../test/roomFixture';

const mocks = vi.hoisted(() => ({ invitations: vi.fn(), profile: vi.fn(), ensure: vi.fn(), stop: vi.fn(), state: vi.fn() }));
vi.mock('./GlobalListeningPublisher', () => ({ GlobalListeningPublisher: () => null }));
vi.mock('../../api/social', () => ({ getSocialProfile: mocks.profile }));
vi.mock('../../api/rooms', () => ({ getRoomInvitations: mocks.invitations,
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }) }));
vi.mock('./roomSession', () => ({ roomSession: { ensure: mocks.ensure, stop: mocks.stop, getSnapshot: mocks.state } }));

const profile = { socialId: 'social-alice', handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const invitation = (): RoomInvitation => ({ invitationId: 'invitation-a', generation: 1,
  inviter: { socialId: 'social-bob', handle: 'bobby', alias: 'Bob', iconSeed: 'bob' }, expiresAtMs: Date.now() + 60_000 });
const show = (viewerId: string | null = 'viewer-a') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(browserSessionQueryKey, viewerId ? { user: { id: viewerId } } : null);
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/search']}>
    <GlobalRoomInvitations />
  </MemoryRouter></QueryClientProvider>);
  return { client, ...view };
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.profile.mockResolvedValue({ profile }); mocks.invitations.mockResolvedValue({ invitations: [] });
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: roomFixture() });
});

test('signed-out listeners neither see the reminder nor request private social data', () => {
  show(null);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
});

test('social invalidation shows and clears pending invitations outside Together without a playback action', async () => {
  show();
  expect(await screen.findByRole('link', { name: 'Room invitations' })).toHaveAttribute('href', '/social/invitations');
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
  mocks.invitations.mockResolvedValue({ invitations: [invitation()] });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('social'));
  expect(await screen.findByRole('link', { name: 'Room invitations: pending invitation' })).toHaveAttribute('data-has-pending', 'true');
  mocks.invitations.mockResolvedValue({ invitations: [] });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('rooms'));
  expect(await screen.findByRole('link', { name: 'Room invitations' })).not.toHaveAttribute('data-has-pending');
});

test('expiry removes the pending marker without waiting for a socket event or server poll', async () => {
  mocks.invitations.mockResolvedValue({ invitations: [{ ...invitation(), expiresAtMs: Date.now() + 250 }] });
  show();
  await screen.findByRole('link', { name: 'Room invitations: pending invitation' });
  await screen.findByRole('link', { name: 'Room invitations' });
  expect(mocks.invitations).toHaveBeenCalledTimes(1);
});

test('shared social wakeups refresh community data only for the current account', async () => {
  const { client } = show();
  await screen.findByRole('link', { name: 'Room invitations' });
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
  const current = ['social', 'viewer-a', 'room-community', 'room-a', 1, 'member-a'];
  const other = ['social', 'viewer-b', 'room-community', 'room-b'];
  client.setQueryData(current, { marker: 'current' });
  client.setQueryData(other, { marker: 'other' });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('social'));
  expect(client.getQueryState(current)?.isInvalidated).toBe(true);
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});

test('room-only gestures invalidate community without refetching profiles, friendships, shares or invitations', async () => {
  const { client } = show(); await screen.findByRole('link', { name: 'Room invitations' });
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
  const keys = ['room-community', 'relationships', 'music-shares'].map(kind => ['social', 'viewer-a', kind, 'room-a', 1, 'member-a']);
  const other = ['social', 'viewer-b', 'room-community', 'other-room'];
  for (const key of [...keys, other]) client.setQueryData(key, { marker: true });
  await act(async () => { mocks.ensure.mock.calls.at(-1)![1]('community'); });
  expect(client.getQueryState(keys[0])?.isInvalidated).toBe(true);
  for (const key of [...keys.slice(1), other]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  expect(mocks.profile).toHaveBeenCalledTimes(1); expect(mocks.invitations).toHaveBeenCalledTimes(1);
});

test('retired room observers cannot refetch outgoing invitations or community before React unmounts them', async () => {
  const { client } = show(); await screen.findByRole('link', { name: 'Room invitations' });
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
  const keys = [['social', 'viewer-a', 'room-community', 'room-a', 1, 'member-a'],
    ['social', 'viewer-a', 'room-outgoing-invitations', 'room-a']];
  for (const key of keys) client.setQueryData(key, { marker: true });
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: null });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('rooms'));
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: roomFixture() });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('rooms'));
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

test('resolving identity hides the reminder and a delayed previous-account invitation cannot light the new badge', async () => {
  let complete!: (value: { invitations: RoomInvitation[] }) => void;
  mocks.invitations.mockImplementation((viewerId: string) => viewerId === 'viewer-a'
    ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ invitations: [] }));
  const { client } = show();
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  act(() => { advanceAccountEpoch(); client.setQueryData(browserSessionResolvingQueryKey, true); });
  await waitFor(() => expect(screen.queryByRole('link')).not.toBeInTheDocument());
  act(() => { client.setQueryData(browserSessionQueryKey, { user: { id: 'viewer-b' } }); client.setQueryData(browserSessionResolvingQueryKey, false); });
  await screen.findByRole('link', { name: 'Room invitations' });
  await act(async () => { complete({ invitations: [invitation()] }); });
  expect(screen.getByRole('link', { name: 'Room invitations' })).not.toHaveAttribute('data-has-pending');
  expect(screen.queryByText('Bob')).not.toBeInTheDocument();
});

test('deactivation removes the reminder and stops the shared social transport', async () => {
  const { client } = show(); await screen.findByRole('link', { name: 'Room invitations' });
  act(() => client.setQueryData(['social', 'viewer-a', 'profile'], { profile: { ...profile, active: false } }));
  await waitFor(() => expect(screen.queryByRole('link')).not.toBeInTheDocument());
  expect(mocks.stop).toHaveBeenCalled();
});

test('a failed invalidation refresh does not present a cached invitation as currently pending', async () => {
  mocks.invitations.mockResolvedValue({ invitations: [invitation()] });
  show(); await screen.findByRole('link', { name: 'Room invitations: pending invitation' });
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
  mocks.invitations.mockRejectedValue(new Error('Refresh unavailable'));
  act(() => mocks.ensure.mock.calls.at(-1)![1]('social'));
  expect(await screen.findByRole('link', { name: 'Room invitations' })).not.toHaveAttribute('data-has-pending');
});
