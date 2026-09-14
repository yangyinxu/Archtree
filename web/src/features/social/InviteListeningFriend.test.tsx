import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomSnapshot } from '../../api/rooms';
import { roomFixture } from '../../test/roomFixture';
import { InviteListeningFriend } from './InviteListeningFriend';
const mocks = vi.hoisted(() => ({ state: { viewerId: 'alice', room: null as RoomSnapshot | null, busy: false, uncertain: null as any, error: null as any, connected: true }, run: vi.fn(), read: vi.fn(), refresh: vi.fn(), check: vi.fn(), retry: vi.fn() }));
vi.mock('../../api/rooms', () => ({ getCurrentRoom: mocks.read }));
vi.mock('./roomInvitationQueries', () => ({ useRoomInvitationConnection: () => ({ ready: true, roomsEnabled: true }) }));
vi.mock('./roomSession', () => ({ useRoomSession: () => mocks.state, roomSession: { getSnapshot: () => mocks.state, run: mocks.run, refresh: mocks.refresh, checkOutcome: mocks.check, retry: mocks.retry } }));
const item = { peer: { socialId: `s_${'b'.repeat(32)}`, alias: 'Bob', handle: 'bobby', iconSeed: 'bob' }, track: { contentType: 'audioTrack' as const, id: 'b'.repeat(24), title: 'Fresh Audio', artworkUrl: '', artistNames: [] }, expiresAtMs: 100_000 };
const show = (strict = false) => {
  const content = <MemoryRouter><InviteListeningFriend viewerId="alice" item={item} expiresInMs={25_000} /></MemoryRouter>;
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
};
beforeEach(() => { advanceAccountEpoch(); vi.clearAllMocks(); mocks.state = { viewerId: 'alice', room: null, busy: false, uncertain: null, error: null, connected: true }; mocks.read.mockResolvedValue({ room: null }); mocks.run.mockResolvedValue(undefined); });
test('viewing and opening confirmation perform no playback or room mutation; confirmed creation precedes invitation', async () => {
  mocks.run.mockImplementation(async action => { if (action.action === 'create') mocks.state.room = roomFixture(); }); show();
  expect(mocks.run).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' }));
  expect(screen.getByRole('dialog', { name: 'Listen together with Bob?' })).toBeInTheDocument(); expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' })); await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
  expect(mocks.run.mock.calls[0][0]).toEqual({ action: 'create', mediaTrackIds: [item.track.id] });
  expect(mocks.run.mock.calls[1][0]).toEqual({ action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: item.peer.socialId });
});
test('unknown creation stops the continuation and exposes original outcome recovery', async () => {
  mocks.run.mockImplementation(async () => { mocks.state.uncertain = { action: 'create', commandId: 'original-command' }; mocks.state.error = 'social.unknown'; });
  show(); fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' })); fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
  await screen.findByRole('button', { name: 'Check outcome' }); expect(mocks.run).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check outcome' })); expect(mocks.check).toHaveBeenCalledTimes(1);
});
test('a room discovered during cold bootstrap is refreshed without creating, leaving or inviting', async () => {
  mocks.read.mockResolvedValue({ room: roomFixture() }); show(); fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' })); await waitFor(() => expect(mocks.refresh).toHaveBeenCalled()); expect(mocks.run).not.toHaveBeenCalled();
});
test('existing host explicitly invites; an observer only gets Open Together', async () => {
  mocks.state.room = roomFixture(); mocks.read.mockResolvedValue({ room: mocks.state.room }); const view = show();
  fireEvent.click(screen.getByRole('button', { name: 'Invite to my room' })); await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1)); expect(mocks.run.mock.calls[0][0].action).toBe('invite');
  view.unmount(); mocks.state.room = { ...roomFixture(), self: { ...roomFixture().self, isController: false } }; show(); expect(screen.getByRole('link', { name: 'Open Together' })).toBeInTheDocument();
});
test('StrictMode permits confirmed room creation and invitation and clears pending state', async () => {
  mocks.run.mockImplementation(async action => { if (action.action === 'create') mocks.state.room = roomFixture(); });
  show(true); fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Invite to my room' })).toBeEnabled();
  expect(mocks.run.mock.calls.map(([action]) => action.action)).toEqual(['create', 'invite']);
});
test('StrictMode permits an existing host to invite and clears pending state', async () => {
  mocks.state.room = roomFixture(); mocks.read.mockResolvedValue({ room: mocks.state.room }); show(true);
  fireEvent.click(screen.getByRole('button', { name: 'Invite to my room' }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Invite to my room' })).toBeEnabled());
  expect(mocks.run.mock.calls[0][0].action).toBe('invite');
});
test('account switch during the safety read prevents any mutation', async () => {
  let resolve!: (value: { room: null }) => void; mocks.read.mockReturnValue(new Promise(yes => { resolve = yes; })); const view = show();
  fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' })); fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
  advanceAccountEpoch(); await act(async () => { resolve({ room: null }); }); expect(mocks.run).not.toHaveBeenCalled(); view.unmount();
});
test('unmount during the safety read prevents any mutation even without an account switch', async () => {
  let resolve!: (value: { room: null }) => void; mocks.read.mockReturnValue(new Promise(yes => { resolve = yes; })); const view = show(true);
  fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' })); fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
  view.unmount(); await act(async () => { resolve({ room: null }); }); expect(mocks.run).not.toHaveBeenCalled();
});
test('unmount while room creation is pending prevents its invitation continuation', async () => {
  let resolve!: () => void;
  mocks.run.mockImplementation(() => new Promise<void>(yes => { resolve = () => { mocks.state.room = roomFixture(); yes(); }; }));
  const view = show(true); fireEvent.click(screen.getByRole('button', { name: 'Create a room and invite' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create paused room and invite' }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
  view.unmount(); await act(async () => { resolve(); });
  expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.run.mock.calls[0][0].action).toBe('create');
});
