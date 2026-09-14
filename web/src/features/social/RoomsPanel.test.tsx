import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { roomFixture } from '../../test/roomFixture';
import type { RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';

const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null, run: vi.fn(), control: vi.fn(), ensure: vi.fn(),
  resync: vi.fn(), pauseLocally: vi.fn(), connected: true, locallyPaused: false, playerError: false }));
vi.mock('./roomSession', () => ({ roomSession: { run: mocks.run, control: mocks.control, ensure: mocks.ensure,
  resync: mocks.resync, pauseLocally: mocks.pauseLocally },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: mocks.connected, locallyPaused: mocks.locallyPaused, busy: false, error: null, uncertain: null }) }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: mocks.playerError ? 'blocked' : null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: [] }), getRoomMedia: async () => ({ items: [] }),
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }),
  getOutgoingRoomInvitations: async () => ({ invitations: [] }) }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: [], nextCursor: null }) }));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...mocks.room!.members[0], active: true, discoverable: true, revision: 1
  }} /></QueryClientProvider>;
  const rendered = render(content());
  return () => rendered.rerender(content());
};
beforeEach(() => { mocks.room = roomFixture(); mocks.connected = true; mocks.locallyPaused = false; mocks.playerError = false; vi.clearAllMocks(); });

test('dragging the seek bar retains the playback precondition seen at gesture start', () => {
  const rerender = show();
  const slider = screen.getByRole('slider', { name: 'Room playback position' });
  fireEvent.pointerDown(slider);
  mocks.room = { ...mocks.room!, revision: 2, timeline: { ...mocks.room!.timeline!, playbackGeneration: 2 } };
  rerender();
  fireEvent.change(slider, { target: { value: '10' } }); fireEvent.pointerUp(slider);
  expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', positionMs: 10_000, expectedPlaybackGeneration: 1 }));
  expect(mocks.control).not.toHaveBeenCalled();
});

test('a suspended room allows its returning host to resume and keeps guest controls disabled', () => {
  mocks.room = { ...mocks.room!, status: 'suspended', controlMode: 'everyone', hostMemberId: 'other-member' };
  const rerender = show();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  mocks.room = { ...mocks.room!, hostMemberId: mocks.room!.self.memberId }; rerender();
  expect(screen.getByRole('button', { name: 'Play for everyone' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Playback control' })).toBeDisabled();
});

test('one primary action resumes the caller and starts a paused room', () => {
  mocks.locallyPaused = true; mocks.room!.timeline!.state = 'paused'; show();
  fireEvent.click(screen.getByRole('button', { name: 'Resume and play for everyone' }));
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('play');
  expect(mocks.resync).not.toHaveBeenCalled();
});

test('a paused device gets a primary personal resume while shared pause stays available', () => {
  mocks.locallyPaused = true; mocks.room!.timeline!.state = 'playing'; show();
  fireEvent.click(screen.getByRole('button', { name: 'Listen along' }));
  expect(mocks.resync).toHaveBeenCalledOnce(); expect(mocks.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pause for everyone' }));
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('pause');
});

test('a Host-control guest can resume locally while waiting for the host', () => {
  mocks.locallyPaused = true; mocks.room!.timeline!.state = 'paused'; mocks.room!.self.canControl = false;
  mocks.room!.hostMemberId = 'other-member'; show();
  expect(screen.getByText('Waiting for the host to start playback.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Listen along' }));
  expect(mocks.resync).toHaveBeenCalledOnce(); expect(mocks.control).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('an autoplay failure uses the primary recovery action and recovery remains disabled offline', () => {
  mocks.playerError = true; mocks.room!.timeline!.state = 'playing'; const rerender = show();
  expect(screen.getByRole('button', { name: 'Listen along' })).toBeEnabled();
  mocks.connected = false; rerender();
  expect(screen.getByRole('button', { name: 'Listen along' })).toBeDisabled();
});
