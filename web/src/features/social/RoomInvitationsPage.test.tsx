import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { browserSessionQueryKey, browserSessionResolvingQueryKey } from '../../api/session';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomCommand, RoomInvitation, RoomSnapshot } from '../../api/rooms';
import type { MessageKey } from '../../localization/contract';
import { roomFixture } from '../../test/roomFixture';
import { RoomInvitationsPage } from './RoomInvitationsPage';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(), invitation: vi.fn(), invitations: vi.fn(), capabilities: vi.fn(),
  run: vi.fn(), ensure: vi.fn(), retry: vi.fn(), checkOutcome: vi.fn(),
  listeners: new Set<() => void>(),
  state: { viewerId: 'viewer-1', room: null as RoomSnapshot | null, connected: true, locallyPaused: false,
    busy: false, error: null as MessageKey | null, uncertain: null as RoomCommand | null }
}));
vi.mock('../../api/social', () => ({ getSocialProfile: mocks.profile }));
vi.mock('../../api/rooms', () => ({ getRoomInvitation: mocks.invitation, getRoomInvitations: mocks.invitations,
  getRoomCapabilities: mocks.capabilities }));
vi.mock('./roomSession', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; };
  return { roomSession: { ensure: mocks.ensure, run: mocks.run, retry: mocks.retry, checkOutcome: mocks.checkOutcome,
    getSnapshot: () => mocks.state }, useRoomSession: () => useSyncExternalStore(subscribe, () => mocks.state) };
});

const invitation = (): RoomInvitation => ({ invitationId: 'i_invitation-1', generation: 3,
  inviter: { socialId: `s_${'a'.repeat(32)}`, handle: 'alice', alias: 'Alice', iconSeed: 'alice' }, expiresAtMs: Date.now() + 60_000 });
const ownProfile = { ...invitation().inviter, active: true, discoverable: true, revision: 1 };
const session = (id = 'viewer-1') => ({ user: { id, email: 'private@example.invalid' } });
const updateRoom = (change: Partial<typeof mocks.state>) => {
  mocks.state = { ...mocks.state, ...change };
  for (const listener of mocks.listeners) listener();
};
const show = (path = '/social/invitations/i_invitation-1', viewer: string | null = 'viewer-1', resolving = false) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, viewer ? session(viewer) : null);
  client.setQueryData(browserSessionResolvingQueryKey, resolving);
  const rendered = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/social" element={<h1>Together destination</h1>} />
    <Route path="/social/invitations" element={<RoomInvitationsPage />} />
    <Route path="/social/invitations/:invitationId" element={<RoomInvitationsPage />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return { client, ...rendered };
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear();
  mocks.state = { viewerId: 'viewer-1', room: null, connected: true, locallyPaused: false, busy: false, error: null, uncertain: null };
  mocks.profile.mockResolvedValue({ profile: ownProfile });
  mocks.invitation.mockResolvedValue({ invitation: invitation() });
  mocks.invitations.mockResolvedValue({ invitations: [invitation()] });
  mocks.capabilities.mockResolvedValue({ socialEnabled: true, roomsEnabled: true });
  mocks.run.mockImplementation(async () => { updateRoom({ busy: true }); await Promise.resolve(); updateRoom({ busy: false }); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('signed-out invitation links preserve only the internal destination and fetch no private state', () => {
  show(undefined, null);
  expect(screen.getByRole('heading', { name: 'Room invitations' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?returnTo=%2Fsocial%2Finvitations%2Fi_invitation-1');
  expect(mocks.invitation).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
  expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('session reconciliation gates both cached identity and invitation queries', async () => {
  const { client } = show(undefined, 'viewer-1', true);
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.invitation).not.toHaveBeenCalled();
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, false); });
  expect(await screen.findByText('Alice invited you to listen together.')).toBeVisible();
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, true); });
  await waitFor(() => expect(screen.queryByText('Alice invited you to listen together.')).not.toBeInTheDocument());
});

test.each(['bad%20id', '%2F%2Fevil.example', 'a'.repeat(81)])('malformed invitation %s never reaches the API', async id => {
  show(`/social/invitations/${id}`);
  expect(screen.getByText(/This invitation is unavailable/)).toBeVisible();
  expect(mocks.invitation).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
});

test('active profile is required, with the same neutral detail result as an unavailable invitation', async () => {
  mocks.profile.mockResolvedValue({ profile: { ...ownProfile, active: false } });
  show();
  expect(await screen.findByText(/This invitation is unavailable/)).toBeVisible();
  expect(mocks.invitation).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
});

test('list route explains profile setup without fetching pending invitations', async () => {
  mocks.profile.mockResolvedValue({ profile: null }); show('/social/invitations');
  expect(await screen.findByText('Set up or reactivate your social profile to view room invitations.')).toBeVisible();
  expect(mocks.invitations).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Together' })).toHaveAttribute('href', '/social');
});

test('an unavailable authorized lookup exposes no inviter or admission controls', async () => {
  mocks.invitation.mockResolvedValue({ invitation: null }); show();
  expect(await screen.findByText(/This invitation is unavailable/)).toBeVisible();
  expect(mocks.invitation).toHaveBeenCalledExactlyOnceWith('viewer-1', 'i_invitation-1', expect.any(AbortSignal));
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeInTheDocument();
  expect(mocks.run).not.toHaveBeenCalled();
});

test('authorized detail exposes only the public inviter and expiry without accepting or playing', async () => {
  show(); expect(await screen.findByText('Alice invited you to listen together.')).toBeVisible();
  expect(screen.getByText('@alice')).toBeVisible(); expect(screen.getByText(/^Expires /)).toBeVisible();
  expect(screen.queryByText('private@example.invalid')).not.toBeInTheDocument();
  expect(screen.queryByText('Quiet interval')).not.toBeInTheDocument();
  expect(mocks.invitations).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('detail expires locally at its deadline without waiting for another server event', async () => {
  const { client } = show(); await screen.findByText('Alice invited you to listen together.');
  vi.useFakeTimers();
  await act(async () => {
    client.setQueryData(['social', 'viewer-1', 'room-invitation', 'i_invitation-1'], { invitation: { ...invitation(), expiresAtMs: Date.now() + 1000 } });
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1002); });
  expect(screen.getByText(/This invitation is unavailable/)).toBeVisible();
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeInTheDocument();
});

test('list uses the shared pending result and filters logically expired entries', async () => {
  mocks.invitations.mockResolvedValue({ invitations: [invitation(), { ...invitation(), invitationId: 'old-invitation', expiresAtMs: Date.now() - 1 }] });
  show('/social/invitations');
  expect(await screen.findAllByText('Alice invited you to listen together.')).toHaveLength(1);
  expect(mocks.invitation).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('an empty inbox has no response controls', async () => {
  mocks.invitations.mockResolvedValue({ invitations: [] }); show('/social/invitations');
  expect(await screen.findByText('No pending room invitations.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeInTheDocument();
  expect(mocks.run).not.toHaveBeenCalled();
});

test('a failed detail revalidation hides its cached inviter and actions until an explicit successful refresh', async () => {
  const { client } = show(); await screen.findByText('Alice invited you to listen together.');
  mocks.invitation.mockRejectedValueOnce(new Error('temporary failure'));
  await act(async () => { await client.refetchQueries({ queryKey: ['social', 'viewer-1', 'room-invitation'] }); });
  const refresh = await screen.findByRole('button', { name: 'Refresh' });
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeInTheDocument();
  fireEvent.click(refresh);
  expect(await screen.findByText('Alice invited you to listen together.')).toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
});

test('detail polling discovers a revoked invitation when realtime cannot invalidate it', async () => {
  mocks.state.connected = false;
  const { client } = show(); await screen.findByText('Alice invited you to listen together.');
  vi.useFakeTimers();
  // Remount the detail observer under the fake clock to exercise its actual fallback interval.
  const pending = invitation();
  mocks.invitation.mockResolvedValueOnce({ invitation: pending }).mockResolvedValue({ invitation: null });
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, true); await vi.advanceTimersByTimeAsync(1); });
  client.setQueryData(['social', 'viewer-1', 'room-invitation', 'i_invitation-1'], { invitation: pending });
  await act(async () => { client.setQueryData(browserSessionResolvingQueryKey, false); await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
  expect(screen.getByText('Alice invited you to listen together.')).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1002); });
  expect(screen.getByText(/This invitation is unavailable/)).toBeVisible();
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument(); expect(mocks.run).not.toHaveBeenCalled();
});

test('failed detail retains explicit, non-mutating recovery', async () => {
  mocks.invitation.mockRejectedValueOnce(new Error('temporary failure'));
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Alice invited you to listen together.')).toBeVisible();
  expect(mocks.invitation).toHaveBeenCalledTimes(2); expect(mocks.run).not.toHaveBeenCalled();
});

test('existing membership blocks Join but allows Decline and never redirects or leaves', async () => {
  mocks.state.room = roomFixture(); show();
  expect(await screen.findByText(/You're already in a room/)).toBeVisible();
  expect(await screen.findByRole('button', { name: 'Join room' })).toBeDisabled();
  const decline = await screen.findByRole('button', { name: 'Decline' });
  await waitFor(() => expect(decline).toBeEnabled()); fireEvent.click(decline);
  await waitFor(() => expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'declineInvitation', invitationId: 'i_invitation-1', generation: 3 }));
  expect(screen.queryByRole('heading', { name: 'Together destination' })).not.toBeInTheDocument();
  expect(mocks.state.room?.roomId).toBe('room-a');
});

test('disabled room rollout retains explicit Decline without a realtime connection', async () => {
  mocks.capabilities.mockResolvedValue({ socialEnabled: false, roomsEnabled: false }); mocks.state.connected = false; show();
  expect(await screen.findByText('Joining rooms is temporarily unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Join room' })).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decline' })); });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'declineInvitation', invitationId: 'i_invitation-1', generation: 3 });
  expect(mocks.ensure).toHaveBeenCalledWith('viewer-1', expect.any(Function), { realtimeEnabled: false });
});

test('failed capability discovery blocks responses until an explicit refresh establishes room support', async () => {
  mocks.capabilities.mockRejectedValueOnce(new Error('temporary capability failure'));
  show();
  const refresh = await screen.findByRole('button', { name: 'Refresh' });
  expect(screen.getByRole('alert')).toHaveTextContent('We could not complete that action. Try again.');
  const join = screen.getByRole('button', { name: 'Join room' });
  const decline = screen.getByRole('button', { name: 'Decline' });
  expect(join).toBeDisabled(); expect(decline).toBeDisabled();
  fireEvent.click(join); fireEvent.click(decline);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
  fireEvent.click(refresh);
  await waitFor(() => { expect(join).toBeEnabled(); expect(decline).toBeEnabled(); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(mocks.capabilities).toHaveBeenCalledTimes(2);
  expect(mocks.ensure).toHaveBeenCalledWith('viewer-1', expect.any(Function), { realtimeEnabled: true });
  expect(mocks.run).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(decline); });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'declineInvitation', invitationId: 'i_invitation-1', generation: 3 });
});

test('Join carries the shown invitation generation and waits for confirmed membership before navigation', async () => {
  let complete!: () => void;
  mocks.run.mockImplementation(async () => { updateRoom({ busy: true }); await new Promise<void>(resolve => { complete = resolve; }); updateRoom({ busy: false, room: roomFixture() }); });
  show(); const join = await screen.findByRole('button', { name: 'Join room' }); await waitFor(() => expect(join).toBeEnabled());
  fireEvent.click(join); fireEvent.click(join);
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'acceptInvitation', invitationId: 'i_invitation-1', generation: 3 });
  expect(screen.queryByRole('heading', { name: 'Together destination' })).not.toBeInTheDocument();
  await act(async () => { complete(); });
  expect(await screen.findByRole('heading', { name: 'Together destination' })).toBeVisible();
});

test('an uncertain acceptance keeps its explicit recovery and navigates only after outcome confirms the room', async () => {
  const command = { action: 'acceptInvitation', invitationId: 'i_invitation-1', generation: 3, commandId: 'original-command-123', scopeToken: 'original-scope-123' } as const;
  mocks.run.mockImplementation(async () => { updateRoom({ busy: true }); await Promise.resolve(); updateRoom({ busy: false, uncertain: command, error: 'social.unknown' }); });
  mocks.checkOutcome.mockImplementation(async () => { updateRoom({ uncertain: null, error: null, room: roomFixture() }); });
  show(); const join = await screen.findByRole('button', { name: 'Join room' }); await waitFor(() => expect(join).toBeEnabled()); fireEvent.click(join);
  const check = await screen.findByRole('button', { name: 'Check outcome' });
  expect(screen.getByRole('button', { name: 'Retry this action' })).toBeEnabled();
  expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.retry).not.toHaveBeenCalled();
  expect(join).toBeDisabled(); expect(screen.queryByRole('heading', { name: 'Together destination' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' }));
  expect(mocks.retry).toHaveBeenCalledOnce();
  expect(mocks.state.uncertain).toBe(command);
  fireEvent.click(check);
  expect(await screen.findByRole('heading', { name: 'Together destination' })).toBeVisible();
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

test('a definite rejection cannot turn a later existing-room refresh into accepted navigation', async () => {
  mocks.run.mockImplementation(async () => { updateRoom({ busy: true }); await Promise.resolve(); updateRoom({ busy: false, error: 'social.stale' }); });
  show(); const join = await screen.findByRole('button', { name: 'Join room' }); await waitFor(() => expect(join).toBeEnabled()); fireEvent.click(join);
  await waitFor(() => expect(mocks.state.busy).toBe(false));
  await act(async () => { updateRoom({ room: roomFixture(), error: null }); });
  expect(screen.queryByRole('heading', { name: 'Together destination' })).not.toBeInTheDocument();
  expect(screen.getByText(/You're already in a room/)).toBeVisible();
});

test('late invitation results and old room recovery controls stay hidden after account changes', async () => {
  let finish!: (value: { invitation: RoomInvitation }) => void;
  mocks.invitation.mockImplementation((viewer: string) => viewer === 'viewer-1'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ invitation: null }));
  const { client } = show(); await waitFor(() => expect(mocks.invitation).toHaveBeenCalledTimes(1));
  await act(async () => {
    advanceAccountEpoch(); client.setQueryData(browserSessionQueryKey, session('viewer-2'));
    updateRoom({ error: 'social.unknown', uncertain: { action: 'declineInvitation', invitationId: 'old', generation: 1, commandId: 'old-command-12345', scopeToken: 'old-scope-12345' } });
    finish({ invitation: invitation() });
  });
  expect(await screen.findByText(/This invitation is unavailable/)).toBeVisible();
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry this action' })).not.toBeInTheDocument();
  expect(mocks.invitation).toHaveBeenLastCalledWith('viewer-2', 'i_invitation-1', expect.any(AbortSignal));
});
