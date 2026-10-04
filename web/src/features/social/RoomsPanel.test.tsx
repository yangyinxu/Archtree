import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { roomFixture } from '../../test/roomFixture';
import type { RoomCommand, RoomSnapshot } from '../../api/rooms';
import { RoomsPanel } from './RoomsPanel';
// Warm the lazily loaded countdown module so its first suspension resolves without a transform delay.
import './RoomDeadline';

const mocks = vi.hoisted(() => ({ room: null as RoomSnapshot | null, run: vi.fn(), control: vi.fn(), ensure: vi.fn(),
  media: vi.fn(),
  resync: vi.fn(), pauseLocally: vi.fn(), retry: vi.fn(), checkOutcome: vi.fn(), uncertain: null as RoomCommand | null,
  connected: true, locallyPaused: false, playerError: false, roomsEnabled: true, error: null as string | null,
  invitations: [] as unknown[], reconnect: vi.fn(), outgoing: [] as unknown[], friends: [] as unknown[], receivedAt: 0 }));
vi.mock('./roomSession', () => ({ roomSession: { run: mocks.run, control: mocks.control, ensure: mocks.ensure,
  resync: mocks.resync, pauseLocally: mocks.pauseLocally, retry: mocks.retry, checkOutcome: mocks.checkOutcome, reconnect: mocks.reconnect },
  useRoomSession: () => ({ viewerId: 'viewer-1', room: mocks.room, connected: mocks.connected, locallyPaused: mocks.locallyPaused, busy: false, error: mocks.error, uncertain: mocks.uncertain, roomReceivedAtMs: mocks.receivedAt }) }));
vi.mock('./RoomSongRequests', () => ({ RoomSongRequests: ({ room }: { room: RoomSnapshot }) => <section aria-label="Song requests">{room.roomId}</section> }));
vi.mock('../../player', () => ({ usePlayer: () => ({ currentItem: null, currentTime: 0, error: mocks.playerError ? 'blocked' : null }) }));
vi.mock('../../api/rooms', async original => ({ ...await original<typeof import('../../api/rooms')>(),
  getRoomInvitations: async () => ({ invitations: mocks.invitations }),
  getRoomCapabilities: async () => ({ socialEnabled: mocks.roomsEnabled, roomsEnabled: mocks.roomsEnabled }),
  getOutgoingRoomInvitations: async () => ({ invitations: mocks.outgoing }) }));
vi.mock('../../api/roomMedia', () => ({ searchRoomMedia: mocks.media }));
vi.mock('../../api/social', () => ({ getSocialPage: async () => ({ items: mocks.friends, nextCursor: null }) }));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><RoomsPanel viewerId="viewer-1" profile={{
    ...roomFixture().members[0], active: true, discoverable: true, revision: 1
  }} /></QueryClientProvider>;
  // Each render or rerender stands for the session accepting `mocks.room` at that moment.
  mocks.receivedAt = performance.now();
  const rendered = render(content());
  return () => { mocks.receivedAt = performance.now(); rendered.rerender(content()); };
};
beforeEach(() => { mocks.room = roomFixture(); mocks.connected = true; mocks.locallyPaused = false; mocks.playerError = false; mocks.uncertain = null; vi.clearAllMocks();
  mocks.roomsEnabled = true; mocks.error = null; mocks.invitations = []; mocks.outgoing = []; mocks.friends = [];
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

test('the seek bar speaks the shown time, following a drag before it is committed', () => {
  show();
  const slider = screen.getByRole('slider', { name: 'Room playback position' });
  expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 0:30');
  fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value: '12.5' } });
  expect(slider).toHaveAttribute('aria-valuetext', '0:12 of 0:30');
});

test('everyone-control guests keep shared controls during the host-absence grace, before suspension', async () => {
  const fixture = roomFixture();
  mocks.room = { ...fixture, status: 'open', controlMode: 'everyone', hostMemberId: 'other-member',
    hostAbsenceDeadlineMs: fixture.serverTimeMs + 20_000, timeline: { ...fixture.timeline!, state: 'paused' }, preparation: null,
    members: [...fixture.members, { ...fixture.members[0], memberId: 'other-member', role: 'host', connected: false }] };
  show();
  expect(await screen.findByRole('timer')).toHaveTextContent(
    'The host is disconnected. Shared playback will be suspended in 0:20 unless the host returns.');
  expect(screen.queryByText(/Shared playback is suspended/)).not.toBeInTheDocument();
  for (const name of ['Previous', 'Next']) expect(screen.getByRole('button', { name })).toBeEnabled();
  expect(screen.getByRole('slider', { name: 'Room playback position' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Play for everyone' }));
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('play');
});

test('a suspended room allows its returning host to resume and keeps guest controls disabled', async () => {
  mocks.room = { ...mocks.room!, status: 'suspended', controlMode: 'everyone', hostMemberId: 'other-member' };
  const rerender = show();
  expect(await screen.findByText('Shared playback is suspended until the host starts it again.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  mocks.room = { ...mocks.room!, hostMemberId: mocks.room!.self.memberId }; rerender();
  expect(screen.getByText('Shared playback is suspended. Start playback for everyone when you are ready.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Play for everyone' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Playback control' })).toBeDisabled();
  expect(mocks.control).not.toHaveBeenCalled();
});

test('a suspended guest sees when the room ends while its host stays absent', async () => {
  const fixture = roomFixture();
  mocks.room = { ...fixture, status: 'suspended', hostMemberId: 'other-member', hostAbsenceDeadlineMs: fixture.serverTimeMs,
    members: [...fixture.members, { ...fixture.members[0], memberId: 'other-member', role: 'host', connected: false }] };
  show();
  expect(await screen.findByRole('timer')).toHaveTextContent('Shared playback is suspended. The room ends in 4:30 unless the host returns.');
  expect(screen.getByRole('button', { name: 'Play for everyone' })).toBeDisabled();
});

test('the transfer recipient sees the offer expiry and accepts only by explicit action', async () => {
  const fixture = roomFixture();
  mocks.room = { ...fixture, hostMemberId: 'other-member', members: [...fixture.members, { ...fixture.members[0], memberId: 'other-member', role: 'host' }],
    transferOffer: { offerId: 'offer-a', targetMemberId: fixture.self.memberId, targetControllerGeneration: 1, expiresAtMs: fixture.serverTimeMs + 30_000 } };
  show();
  expect(await screen.findByRole('timer')).toHaveTextContent('This offer expires in 0:30.');
  expect(screen.getByText(/The host offered you the host role/)).toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Accept host role' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'acceptTransfer', roomId: 'room-a', memberId: 'member-a', offerId: 'offer-a' });
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

test('disabled rooms explain unavailability instead of connecting and keep only safety actions', async () => {
  mocks.room = null; mocks.connected = false; mocks.roomsEnabled = false; mocks.error = 'room.disconnected';
  mocks.invitations = [{ invitationId: 'invitation-a', generation: 2, expiresAtMs: Date.now() + 60_000,
    inviter: { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' } }];
  show();
  expect(await screen.findByText('Listening rooms are temporarily unavailable.')).toBeVisible();
  expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  expect(screen.queryByText('Start a room, choose a few songs, and invite your friends.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start a room' })).not.toBeInTheDocument();
  // Reconnecting cannot succeed while the rollout is off, so it is not offered as a repair.
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Join room' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'declineInvitation', invitationId: 'invitation-a', generation: 2 });
  expect(mocks.media).not.toHaveBeenCalled();
});

test('a current room stays exitable while rooms are disabled', async () => {
  mocks.connected = false; mocks.roomsEnabled = false; show();
  expect(await screen.findByText('Listening rooms are temporarily unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'End room' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'end', roomId: 'room-a', memberId: 'member-a' });
});

test('an enabled but disconnected room still offers reconnection', async () => {
  mocks.connected = false; mocks.error = 'room.disconnected'; show();
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  expect(mocks.reconnect).toHaveBeenCalledOnce();
  expect(screen.getByText('Connecting…')).toBeVisible();
});

const bob = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };

test('removing a member asks the host first and sends only the confirmed kick', async () => {
  mocks.room = { ...roomFixture(), members: [...roomFixture().members, { ...bob, memberId: 'member-b', role: 'guest',
    controllerGeneration: 1, connected: true, ready: true }] };
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Remove from room' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove Bob from the room?' });
  expect(dialog).toHaveAccessibleDescription('Bob leaves this room right away and stops listening with everyone. You can invite them again later.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove from room' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Bob from the room?' })).getByRole('button', { name: 'Remove from room' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'kick', roomId: 'room-a', memberId: 'member-a', targetMemberId: 'member-b' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a pending invitation can be copied or explicitly replaced so its earlier link stops working', async () => {
  mocks.friends = [{ socialId: bob.socialId, profile: bob, revision: 2 }];
  mocks.outgoing = [{ invitationId: 'invitation-b', generation: 1, recipientSocialId: bob.socialId, expiresAtMs: Date.now() + 60_000 }];
  show();
  expect(await screen.findByText('Invitation pending')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy invitation link' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send new invitation' }));
  const dialog = await screen.findByRole('dialog', { name: 'Send Bob a new invitation?' });
  expect(dialog).toHaveAccessibleDescription(/The current invitation link stops working/);
  expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invitation' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: bob.socialId });
});

test('a replacement dialog closes without sending when its invitation is no longer pending', async () => {
  mocks.friends = [{ socialId: bob.socialId, profile: bob, revision: 2 }];
  mocks.outgoing = [{ invitationId: 'invitation-b', generation: 1, recipientSocialId: bob.socialId, expiresAtMs: Date.now() + 60_000 }];
  const rerender = show();
  fireEvent.click(await screen.findByRole('button', { name: 'Send new invitation' }));
  await screen.findByRole('dialog', { name: 'Send Bob a new invitation?' });
  // Bob accepted meanwhile and is now a member.
  mocks.room = { ...roomFixture(), members: [...roomFixture().members, { ...bob, memberId: 'member-b', role: 'guest',
    controllerGeneration: 1, connected: true, ready: false }] };
  rerender();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.run).not.toHaveBeenCalled();
});

test('a friend without a pending invitation gets an ordinary Invite and no replacement', async () => {
  mocks.friends = [{ socialId: bob.socialId, profile: bob, revision: 2 }];
  show();
  expect(await screen.findByRole('heading', { name: 'Invite a friend' })).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: bob.socialId });
  expect(screen.queryByRole('button', { name: 'Send new invitation' })).not.toBeInTheDocument();
});

test('guests see neither member management nor host invitations', async () => {
  mocks.friends = [{ socialId: bob.socialId, profile: bob, revision: 2 }];
  mocks.room = { ...roomFixture(), hostMemberId: 'member-b', members: [...roomFixture().members, { ...bob, memberId: 'member-b', role: 'host',
    controllerGeneration: 1, connected: true, ready: true }] };
  show();
  expect(await screen.findByRole('region', { name: 'Song requests' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove from room' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Invite a friend' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
});

test('member rows say who is connected and show readiness only for connected members', async () => {
  mocks.room = { ...roomFixture(), members: [...roomFixture().members,
    { ...bob, memberId: 'member-b', role: 'guest', controllerGeneration: 1, connected: false, ready: true }] };
  show();
  const members = screen.getByRole('heading', { name: 'In this room' }).nextElementSibling as HTMLElement;
  const [alice, guest] = within(members).getAllByRole('listitem');
  expect(within(alice).getByText('Host · Connected · Not ready')).toBeVisible();
  expect(within(guest).getByText('Guest · Not connected')).toBeVisible();
  expect(guest).not.toHaveTextContent('Ready');
  // Each member gets the same generated icon as everywhere else in Together.
  expect(guest.querySelector('[aria-hidden="true"]')).toHaveTextContent('B');
  // Only a connected member can take over, so Transfer stays disabled for the disconnected guest.
  expect(await within(guest).findByRole('button', { name: 'Transfer and leave' })).toBeDisabled();
});
