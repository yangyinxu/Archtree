import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { socialRolloutGateEvent } from '../../api/client';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import type { RoomInvitation } from '../../api/rooms';
import { GlobalRoomInvitations } from './GlobalRoomInvitations';
import { roomFixture } from '../../test/roomFixture';
import { seedListenerCapabilities, type SocialRollout } from '../../test/listenerCapabilities';

const mocks = vi.hoisted(() => ({ invitations: vi.fn(), profile: vi.fn(), ensure: vi.fn(), stop: vi.fn(), state: vi.fn(), publisher: vi.fn(() => null) }));
vi.mock('./GlobalListeningPublisher', () => ({ GlobalListeningPublisher: mocks.publisher }));
vi.mock('../../api/social', () => ({ getSocialProfile: mocks.profile }));
vi.mock('../../api/rooms', () => ({ getRoomInvitations: mocks.invitations,
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }) }));
vi.mock('./roomSession', () => ({ useRoomSession: mocks.state, roomSession: { ensure: mocks.ensure, stop: mocks.stop, getSnapshot: mocks.state } }));

const profile = { socialId: 'social-alice', handle: 'alice', alias: 'Alice', iconSeed: 'alice', active: true, discoverable: true, revision: 1 };
const invitation = (): RoomInvitation => ({ invitationId: 'invitation-a', generation: 1,
  inviter: { socialId: 'social-bob', handle: 'bobby', alias: 'Bob', iconSeed: 'bob' }, expiresAtMs: Date.now() + 60_000 });
const show = (viewerId: string | null = 'viewer-a', social?: SocialRollout) => {
  const client = seedListenerCapabilities(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }), social);
  client.setQueryData(browserSessionQueryKey, viewerId ? { user: { id: viewerId } } : null);
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/search']}>
    <GlobalRoomInvitations />
  </MemoryRouter></QueryClientProvider>);
  return { client, ...view };
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.profile.mockResolvedValue({ profile }); mocks.invitations.mockResolvedValue({ invitations: [] });
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: roomFixture(), connected: true, locallyPaused: false });
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
  const other = keys.map(key => [key[0], 'viewer-b', ...key.slice(2)]);
  for (const key of [...keys, ...other]) client.setQueryData(key, { marker: true });
  for (const room of [null, { ...roomFixture(), status: 'ended' as const }]) {
    mocks.state.mockReturnValue({ viewerId: 'viewer-a', room });
    for (const kind of ['rooms', 'community', 'social']) {
      act(() => mocks.ensure.mock.calls.at(-1)![1](kind));
      for (const key of [...keys, ...other]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    }
  }
  mocks.state.mockReturnValue({ viewerId: 'viewer-a', room: roomFixture() });
  act(() => mocks.ensure.mock.calls.at(-1)![1]('rooms'));
  expect(client.getQueryState(keys[0])?.isInvalidated).toBe(false);
  expect(client.getQueryState(keys[1])?.isInvalidated).toBe(true);
  for (const kind of ['community', 'social']) {
    client.setQueryData(keys[0], { marker: true });
    act(() => mocks.ensure.mock.calls.at(-1)![1](kind));
    expect(client.getQueryState(keys[0])?.isInvalidated).toBe(true);
    for (const key of other) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  }
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

test('social without rooms hides room entry points while transport and listening status keep their own rules', async () => {
  const { client } = show('viewer-a', { enabled: true, rooms: false });
  await waitFor(() => expect(mocks.publisher).toHaveBeenCalled());
  // The transport still follows the account room capability so a later enablement or safety exit is not lost.
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith('viewer-a', expect.any(Function), { realtimeEnabled: true }));
  expect(screen.queryByRole('link', { name: /^Room invitations/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^Open room/ })).not.toBeInTheDocument();
  expect(mocks.invitations).not.toHaveBeenCalled();
  act(() => { seedListenerCapabilities(client); });
  expect(await screen.findByRole('link', { name: 'Room invitations' })).toBeVisible();
  expect(screen.getByRole('link', { name: /^Open room/ })).toBeVisible();
});

test('a rollout gate response refreshes public and account room capabilities until unmounted', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  const { client, unmount } = show(null);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  act(() => { window.dispatchEvent(new Event(socialRolloutGateEvent)); });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: listenerCapabilitiesQueryKey });
  const accountCapabilities = invalidate.mock.calls.map(([filters]) => filters?.predicate).find(Boolean)!;
  const query = (queryKey: unknown[]) => ({ queryKey }) as unknown as Parameters<typeof accountCapabilities>[0];
  expect(accountCapabilities(query(['social', 'viewer-a', 'room-capabilities']))).toBe(true);
  expect(accountCapabilities(query(['social', 'viewer-a', 'room-invitations']))).toBe(false);
  expect(accountCapabilities(query(['listener', 'capabilities']))).toBe(false);
  unmount(); invalidate.mockClear();
  window.dispatchEvent(new Event(socialRolloutGateEvent));
  expect(invalidate).not.toHaveBeenCalled();
});
