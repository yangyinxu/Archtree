import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { roomFixture } from '../../test/roomFixture';
import type { RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';
// Warm the lazily loaded countdown module so a transfer offer's first suspension resolves without a transform delay.
import './RoomDeadline';

const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null, run: vi.fn(), control: vi.fn(), reconnect: vi.fn(),
  connected: true, error: null as string | null }));
vi.mock('./roomSession', () => ({
  roomSession: { run: mocks.run, control: mocks.control, reconnect: mocks.reconnect, ensure: vi.fn(),
    resync: vi.fn(), pauseLocally: vi.fn(), retry: vi.fn(), checkOutcome: vi.fn() },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: mocks.connected, locallyPaused: false, busy: false,
    error: mocks.error, uncertain: null, roomReceivedAtMs: 0 })
}));
vi.mock('./RoomSongRequests', () => ({ RoomSongRequests: () => null }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: [] }),
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }),
  getOutgoingRoomInvitations: async () => ({ invitations: [] }) }));
vi.mock('../../api/roomMedia', () => ({ searchRoomMedia: async () => ({ items: [], nextCursor: null }) }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: [], nextCursor: null }) }));

const host = roomFixture().members[0];
const bob = { ...host, socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob', memberId: 'member-b', role: 'guest' as const };
/** A paused room shared by Alice (`member-a`, this viewer) and Bob, hosted by whichever the caller names. */
const sharedRoom = (hostMemberId: 'member-a' | 'member-b'): RoomSnapshot => {
  const fixture = roomFixture();
  return { ...fixture, hostMemberId, timeline: { ...fixture.timeline!, state: 'paused' }, preparation: null,
    members: [{ ...host, role: hostMemberId === 'member-a' ? 'host' : 'guest' }, { ...bob, role: hostMemberId === 'member-b' ? 'host' : 'guest' }] };
};
const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...host, active: true, discoverable: true, revision: 1 }} /></QueryClientProvider>;
  const rendered = render(content());
  return () => rendered.rerender(content());
};
const memberRow = (alias: string) => within(screen.getByRole('heading', { name: 'In this room' }).parentElement!).getByText(alias).closest('li')!;
let nativeConfirm: MockInstance<typeof window.confirm>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.room = sharedRoom('member-a'); mocks.connected = true; mocks.error = null;
  nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('the host removes a guest by explicit action and has no removal control for itself', async () => {
  show();
  const remove = await within(memberRow('Bob')).findByRole('button', { name: 'Remove from room' });
  expect(within(memberRow('Alice')).queryByRole('button', { name: 'Remove from room' })).not.toBeInTheDocument();
  expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(remove);
  // Whether removal must ask first has its own tests; this flow confirms an in-page dialog when one is shown.
  await waitFor(() => expect(mocks.run.mock.calls.length > 0 || screen.queryByRole('dialog') !== null).toBe(true));
  const dialog = screen.queryByRole('dialog');
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from room' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'kick', roomId: 'room-a', memberId: 'member-a', targetMemberId: 'member-b' });
  expect(mocks.control).not.toHaveBeenCalled();
});

test('a guest leaves at once without ending the room or managing other members', () => {
  mocks.room = sharedRoom('member-b'); show();
  expect(screen.queryByRole('button', { name: 'End room' })).not.toBeInTheDocument();
  for (const name of ['Remove from room', 'Transfer and leave']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
  // Leaving affects only this member, so it needs no confirmation.
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'leave', roomId: 'room-a', memberId: 'member-a' });
});

test('ending the room for everyone needs the host to confirm, and declining sends nothing', () => {
  show();
  nativeConfirm.mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'End room' }));
  expect(nativeConfirm).toHaveBeenCalledExactlyOnceWith('End this room for everyone?');
  expect(mocks.run).not.toHaveBeenCalled();
  nativeConfirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'End room' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'end', roomId: 'room-a', memberId: 'member-a' });
});

test('the host cancels a pending transfer and cannot offer another while it is pending', async () => {
  const room = sharedRoom('member-a');
  mocks.room = { ...room, transferOffer: { offerId: 'offer-a', targetMemberId: 'member-b', targetControllerGeneration: 1, expiresAtMs: room.serverTimeMs + 30_000 } };
  show();
  expect(await within(memberRow('Bob')).findByRole('button', { name: 'Transfer and leave' })).toBeDisabled();
  // Only the selected participant may accept the offer.
  expect(screen.queryByRole('button', { name: 'Accept host role' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'cancelTransfer', roomId: 'room-a', memberId: 'member-a', offerId: 'offer-a' });
});

test('a lost connection offers Reconnect, which reconnects without sending a room command', () => {
  mocks.room = sharedRoom('member-b'); mocks.connected = false; mocks.error = 'room.disconnected'; const rerender = show();
  const status = screen.getByText(/^Connection lost\. After reconnecting, use the play button to listen again\./);
  expect(status).toHaveAttribute('role', 'status');
  // The membership stays, and leaving needs no live connection.
  expect(screen.getByRole('button', { name: 'Leave room' })).toBeEnabled();
  fireEvent.click(within(status).getByRole('button', { name: 'Reconnect' }));
  expect(mocks.reconnect).toHaveBeenCalledOnce();
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();

  mocks.connected = true; mocks.error = null; rerender();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  expect(screen.getByText('Connected')).toBeVisible();
  // A connected session's command failure is not a transport problem, so it offers no reconnection.
  mocks.error = 'social.error'; rerender();
  expect(screen.getByText('We could not complete that action. Try again.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});
