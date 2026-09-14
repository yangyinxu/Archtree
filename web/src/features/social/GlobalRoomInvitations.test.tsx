import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomInvitation } from '../../api/rooms';
import { GlobalRoomInvitations } from './GlobalRoomInvitations';

const mocks = vi.hoisted(() => ({ invitations: vi.fn(), profile: vi.fn(), ensure: vi.fn(), stop: vi.fn() }));
vi.mock('../../api/social', () => ({ getSocialProfile: mocks.profile }));
vi.mock('../../api/rooms', () => ({ getRoomInvitations: mocks.invitations,
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }) }));
vi.mock('./roomSession', () => ({ roomSession: { ensure: mocks.ensure, stop: mocks.stop } }));

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
