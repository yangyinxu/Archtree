import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { roomFixture } from '../../test/roomFixture';
import type { RoomCommand, RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';

const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null, run: vi.fn(), control: vi.fn(), ensure: vi.fn(),
  media: vi.fn(),
  resync: vi.fn(), pauseLocally: vi.fn(), retry: vi.fn(), checkOutcome: vi.fn(), uncertain: null as RoomCommand | null,
  connected: true, locallyPaused: false, playerError: false }));
vi.mock('./roomSession', () => ({ roomSession: { run: mocks.run, control: mocks.control, ensure: mocks.ensure,
  resync: mocks.resync, pauseLocally: mocks.pauseLocally, retry: mocks.retry, checkOutcome: mocks.checkOutcome },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: mocks.connected, locallyPaused: mocks.locallyPaused, busy: false, error: null, uncertain: mocks.uncertain }) }));
vi.mock('./RoomSongRequests', () => ({ RoomSongRequests: ({ room }: { room: RoomSnapshot }) => <section aria-label="Song requests">{room.roomId}</section> }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: mocks.playerError ? 'blocked' : null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: [] }),
  getRoomCapabilities: async () => ({ socialEnabled: true, roomsEnabled: true }),
  getOutgoingRoomInvitations: async () => ({ invitations: [] }) }));
vi.mock('../../api/roomMedia', () => ({ searchRoomMedia: mocks.media }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: [], nextCursor: null }) }));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...roomFixture().members[0], active: true, discoverable: true, revision: 1
  }} /></QueryClientProvider>;
  const rendered = render(content());
  return () => rendered.rerender(content());
};
beforeEach(() => { mocks.room = roomFixture(); mocks.connected = true; mocks.locallyPaused = false; mocks.playerError = false; mocks.uncertain = null; vi.clearAllMocks();
  mocks.media.mockReset(); mocks.media.mockResolvedValue({ items: [], nextCursor: null }); });

test('creation selects songs across search pages and sends only the explicit independent queue', async () => {
  mocks.room = null;
  const first = roomFixture().queue[0], second = { ...first, mediaTrackId: 'b'.repeat(24), title: 'An older favorite' };
  mocks.media.mockImplementation(async (_viewer, input) => ({ items: [input.query ? second : first], nextCursor: null }));
  show(); expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Quiet interval 0:30' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search room-ready songs' }), { target: { value: 'older' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'An older favorite 0:30' }));
  expect(screen.getByRole('list', { name: 'Selected songs (2)' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Start a room' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'create', mediaTrackIds: [first.mediaTrackId, second.mediaTrackId] });
  expect(mocks.control).not.toHaveBeenCalled();
});

test('room admission retires the previous creation selection instead of restoring it after room exit', async () => {
  mocks.room = null; mocks.media.mockResolvedValue({ items: [roomFixture().queue[0]], nextCursor: null });
  const rerender = show(); fireEvent.click(await screen.findByRole('checkbox', { name: 'Quiet interval 0:30' }));
  mocks.room = roomFixture(); rerender();
  await screen.findByRole('region', { name: 'Song requests' });
  mocks.room = null; rerender();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start a room' })).toBeDisabled());
  expect(screen.queryByRole('list', { name: /Selected songs/ })).not.toBeInTheDocument();
});

test('the existing active room exposes its lazy song request panel without initiating a command', async () => {
  show(); expect(await screen.findByRole('region', { name: 'Song requests' })).toHaveTextContent('room-a');
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('reconnection may clear a status message but cannot hide uncertain mutation recovery', () => {
  mocks.uncertain = { action: 'dismissSongRequest', roomId: 'room-a', memberId: 'member-a', requestId: 'request-a',
    commandId: 'original-command-123', scopeToken: 'original-scope-123' }; show();
  fireEvent.click(screen.getByRole('button', { name: 'Check outcome' })); expect(mocks.checkOutcome).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' })); expect(mocks.retry).toHaveBeenCalledOnce();
  expect(mocks.run).not.toHaveBeenCalled();
});

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
