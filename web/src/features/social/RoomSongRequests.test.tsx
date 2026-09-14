import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RoomCommand, RoomSnapshot } from '../../api/rooms';
import type { RoomCommunity } from '../../api/roomCommunity';
import { roomFixture } from '../../test/roomFixture';
import { RoomSongRequests } from './RoomSongRequests';

const mocks = vi.hoisted(() => ({ community: vi.fn(), media: vi.fn(), run: vi.fn(), control: vi.fn(),
  state: { viewerId: 'viewer-1', room: null as RoomSnapshot | null, connected: true, locallyPaused: false,
    busy: false, error: null, uncertain: null as RoomCommand | null } }));
vi.mock('../../api/roomCommunity', () => ({ getRoomCommunity: mocks.community }));
vi.mock('../../api/roomMedia', () => ({ searchRoomMedia: mocks.media }));
vi.mock('./roomSession', () => ({ roomSession: { getSnapshot: () => mocks.state, run: mocks.run, control: mocks.control },
  useRoomSession: () => mocks.state }));

const guest = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob',
  memberId: 'member-b', role: 'guest' as const, controllerGeneration: 1, connected: true, ready: true };
const card = { socialId: guest.socialId, handle: guest.handle, alias: guest.alias, iconSeed: guest.iconSeed };
const room = (): RoomSnapshot => {
  const value = roomFixture(); value.controlMode = 'hostOnly'; value.timeline!.state = 'playing'; value.preparation = null;
  value.members.push(guest);
  value.queue.push({ ...value.queue[0], entryId: 'entry-b', mediaTrackId: 'b'.repeat(24), title: 'Another song',
    streamUrl: `/content/mediaTrack/stream/${'b'.repeat(24)}?revision=revision-a` });
  return value;
};
const community = (): RoomCommunity => ({ roomId: 'room-a', epoch: 1, revision: 1, events: [],
  requests: [{ requestId: 'request-a', mediaTrackId: 'c'.repeat(24), title: 'A requested song', requestedBy: card, createdAtMs: 1_000_000 }],
  queueCredits: [{ entryId: 'entry-a', requestedBy: null }, { entryId: 'entry-b', requestedBy: card }] });
const asGuest = (observer = false) => {
  mocks.state.room!.self = { memberId: guest.memberId, controllerGeneration: 1, isController: !observer, canControl: false };
};
const show = (value = mocks.state.room!) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderedRoom = value;
  const content = () => <QueryClientProvider client={client}><RoomSongRequests viewerId="viewer-1" room={renderedRoom} /></QueryClientProvider>;
  const view = render(content());
  return { client, rerender(next = mocks.state.room!) { renderedRoom = next; view.rerender(content()); } };
};
const chooseSong = async () => {
  const picker = await screen.findByRole('radio', { name: 'Fresh choice 0:30' });
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  return picker;
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.state = { viewerId: 'viewer-1', room: room(), connected: true, locallyPaused: false, busy: false, error: null, uncertain: null };
  mocks.community.mockResolvedValue({ community: community() });
  mocks.media.mockResolvedValue({ items: [{ ...mocks.state.room!.queue[0], mediaTrackId: 'd'.repeat(24), title: 'Fresh choice' }], nextCursor: null });
  mocks.run.mockResolvedValue(undefined);
});

test.each([false, true])('Host-control guest (observer=%s) requests without acquiring playback control', async observer => {
  asGuest(observer); show(); await chooseSong();
  fireEvent.click(screen.getByRole('button', { name: 'Request song' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'requestSong', roomId: 'room-a', memberId: 'member-b', expectedEpoch: 1, mediaTrackId: 'd'.repeat(24) });
  expect(mocks.control).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Play for everyone Quiet interval' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
});

test('a replacement membership discards the selected recommendation while preserving the authoritative queue', async () => {
  asGuest(); const view = show(); await chooseSong();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeEnabled();
  const previous = mocks.state.room!;
  mocks.state.room = { ...previous, self: { ...previous.self, memberId: 'member-b-returned' },
    members: previous.members.map(member => member.memberId === 'member-b' ? { ...member, memberId: 'member-b-returned' } : member) };
  view.rerender();
  await waitFor(() => expect(mocks.community).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('list', { name: /Selected songs/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  expect(within(screen.getByRole('region', { name: 'Room queue' })).getAllByRole('listitem')).toHaveLength(2);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('members withdraw only their own request and an observer host cannot moderate another member', async () => {
  asGuest(true); const view = show();
  fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'dismissSongRequest', roomId: 'room-a', memberId: 'member-b', requestId: 'request-a' });
  mocks.state.room = { ...mocks.state.room!, self: { memberId: 'member-a', controllerGeneration: 1, isController: false, canControl: false } }; view.rerender();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Move .* earlier/ })).not.toBeInTheDocument();
});

test('host acceptance keeps the displayed playback and queue preconditions and performs no optimistic playback', async () => {
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Add to queue' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'acceptSongRequest', requestId: 'request-a', roomId: 'room-a', memberId: 'member-a',
    controllerGeneration: 1, expectedEpoch: 1, expectedControlGeneration: 1, expectedPlaybackGeneration: 1, expectedQueueRevision: 1, expectedEntryId: 'entry-a' });
  expect(within(screen.getByRole('region', { name: 'Room queue' })).getAllByRole('listitem')).toHaveLength(2);
  expect(mocks.control).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
});

test('queue removal protects the current entry and reordering sends a complete immutable observed order', async () => {
  show(); await screen.findByRole('button', { name: 'Add to queue' });
  const current = screen.getByRole('button', { name: 'Remove Quiet interval from queue' });
  expect(current).toBeDisabled(); fireEvent.click(current); expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Move Another song earlier' }));
  expect(mocks.run.mock.calls[0][0]).toMatchObject({ action: 'reorderQueue', entryIds: ['entry-b', 'entry-a'], expectedQueueRevision: 1, expectedPlaybackGeneration: 1, expectedEntryId: 'entry-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Another song from queue' }));
  expect(mocks.run.mock.calls[1][0]).toMatchObject({ action: 'removeQueueEntry', targetEntryId: 'entry-b', expectedQueueRevision: 1, expectedEntryId: 'entry-a' });
  expect(mocks.state.room!.queue.map(entry => entry.entryId)).toEqual(['entry-a', 'entry-b']);
  expect(mocks.control).not.toHaveBeenCalled();
});

test('Everyone playback permission never grants queue moderation to a guest', async () => {
  asGuest(); mocks.state.room!.controlMode = 'everyone'; mocks.state.room!.self.canControl = true; show();
  await screen.findByText('A requested song');
  expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Remove .* from queue/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Play for everyone Another song' }));
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('select', 'entry-b');
});

test('offline withdrawal remains available while requesting and queue edits are disabled', async () => {
  asGuest(); mocks.state.connected = false; show();
  const withdraw = await screen.findByRole('button', { name: 'Withdraw request' });
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  expect(withdraw).toBeEnabled(); fireEvent.click(withdraw);
  expect(mocks.run).toHaveBeenCalledOnce();
});

test('uncertain results block every new request and queue edit without issuing a fresh command', async () => {
  mocks.state.uncertain = { action: 'requestSong', roomId: 'room-a', memberId: 'member-a', expectedEpoch: 1,
    mediaTrackId: 'd'.repeat(24), scopeToken: 'original-scope-123', commandId: 'original-command-123' };
  show(); await screen.findByText('A requested song');
  for (const button of screen.getAllByRole('button')) { expect(button).toBeDisabled(); fireEvent.click(button); }
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('duplicate own requests and five pending requests cannot be submitted again', async () => {
  asGuest(); const value = community(); value.requests[0].mediaTrackId = 'd'.repeat(24);
  mocks.community.mockResolvedValue({ community: value }); const view = show();
  await screen.findByText('A requested song');
  const pending = await screen.findByRole('radio', { name: 'Fresh choice 0:30 · Already requested' });
  expect(pending).toBeDisabled(); fireEvent.click(pending);
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  await act(async () => { view.client.setQueryData(['social', 'viewer-1', 'room-community', 'room-a', 1, 'member-b'], { community: { ...value,
    requests: Array.from({ length: 5 }, (_, index) => ({ ...value.requests[0], requestId: `request-${index}` })) } }); });
  expect(await screen.findByText('You can have up to five pending song requests.')).toBeVisible();
  expect(screen.getByRole('searchbox', { name: 'Search room-ready songs' })).toBeDisabled();
});

test('room-wide request capacity explains why a member with no own requests cannot submit', async () => {
  const value = community(); value.requests = Array.from({ length: 20 }, (_, index) => ({ ...value.requests[0], requestId: `request-${index}` }));
  mocks.community.mockResolvedValue({ community: value }); show();
  expect(await screen.findByText('The room can have up to 20 pending song requests.')).toBeVisible();
  expect(screen.queryByText('You can have up to five pending song requests.')).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search room-ready songs' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
});

test('a failed eligible-media read blocks recommendation until refreshed without blocking existing queue control', async () => {
  mocks.media.mockRejectedValueOnce(new Error('Unavailable')); show();
  const refresh = await screen.findByRole('button', { name: 'Refresh' });
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Play for everyone Another song' })).toBeEnabled();
  fireEvent.click(refresh); await chooseSong();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeEnabled();
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('a full queue blocks acceptance and a suspended host retains only the existing playback recovery', async () => {
  mocks.state.room!.queue = Array.from({ length: 100 }, (_, index) => ({ ...mocks.state.room!.queue[0], entryId: index ? `entry-${index}` : 'entry-a' }));
  const view = show(); expect(await screen.findByRole('button', { name: 'Add to queue' })).toBeDisabled();
  mocks.state.room = { ...mocks.state.room!, status: 'suspended' }; view.rerender();
  expect(screen.getByRole('button', { name: 'Add to queue' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Play for everyone Quiet interval' })[0]).toBeEnabled();
});

test('community is account and room scoped; an old room cannot reveal metadata or send commands', () => {
  const previous = mocks.state.room!;
  mocks.state.room = { ...previous, roomId: 'room-other' }; show(previous);
  expect(screen.queryByRole('region')).not.toBeInTheDocument(); expect(mocks.community).not.toHaveBeenCalled();
  expect(mocks.media).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test('another epoch metadata is hidden while the new room queue remains authoritative', async () => {
  mocks.community.mockResolvedValue({ community: { ...community(), epoch: 2 } }); show();
  await waitFor(() => expect(mocks.community).toHaveBeenCalled());
  expect(screen.queryByText('A requested song')).not.toBeInTheDocument();
  expect(screen.queryByText('Requested by Bob')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
});

test.each(['membership', 'authority'] as const)('a new %s incarnation starts a fresh read without revealing previous cached requests or credits', async incarnation => {
  const view = show(); await screen.findByText('A requested song');
  expect(screen.getAllByText('Requested by Bob')).toHaveLength(2);
  let finish!: (value: { community: RoomCommunity }) => void;
  mocks.community.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const previous = mocks.state.room!;
  mocks.state.room = incarnation === 'membership' ? { ...previous, hostMemberId: 'member-a-returned',
    self: { ...previous.self, memberId: 'member-a-returned' },
    members: previous.members.map(member => member.memberId === previous.self.memberId ? { ...member, memberId: 'member-a-returned' } : member)
  } : { ...previous, epoch: previous.epoch + 1 };
  view.rerender();
  expect(screen.queryByText('A requested song')).not.toBeInTheDocument();
  expect(screen.queryByText('Requested by Bob')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request song' })).toBeDisabled();
  await waitFor(() => expect(mocks.community).toHaveBeenCalledTimes(2));
  await act(async () => { finish({ community: { ...community(), epoch: mocks.state.room!.epoch, requests: [], queueCredits: [] } }); });
  expect(await screen.findByText('No pending song requests.')).toBeVisible();
  expect(screen.queryByText('Requested by Bob')).not.toBeInTheDocument();
  expect(mocks.run).not.toHaveBeenCalled();
});

test('departed requester metadata disappears immediately and current aliases replace stale cached aliases', async () => {
  mocks.state.room!.members[1] = { ...guest, alias: 'New Bob' }; const view = show();
  expect(await screen.findAllByText('Requested by New Bob')).toHaveLength(2);
  mocks.state.room = { ...mocks.state.room!, members: [mocks.state.room!.members[0]] }; view.rerender();
  expect(screen.queryByText('A requested song')).not.toBeInTheDocument();
  expect(screen.queryByText('Requested by New Bob')).not.toBeInTheDocument();
});

test('song requests and activity consume one membership-scoped query without reaction or playback echoes', async () => {
  const value = community(); value.events = [{ eventId: 'event-joined', kind: 'joined', actor: card, reaction: null,
    createdAtMs: Date.now(), expiresAtMs: Date.now() + 30_000 }];
  mocks.community.mockResolvedValue({ community: value }); const view = show();
  expect(await screen.findByText('A requested song')).toBeVisible();
  expect(await screen.findByText('Bob joined the room.')).toBeVisible(); expect(mocks.community).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status', { name: 'Room activity' })).toBeEmptyDOMElement();
  await act(async () => { view.client.setQueryData(['social', 'viewer-1', 'room-community', 'room-a', 1, 'member-a'], {
    community: { ...value, revision: 2, requests: [], events: [...value.events, { ...value.events[0], eventId: 'event-heart', kind: 'reaction', reaction: 'heart' }] }
  }); });
  expect(await screen.findByText('No pending song requests.')).toBeVisible();
  expect(screen.getByRole('list', { name: 'Room activity' })).toHaveTextContent('Bob reacted ❤️');
  expect(screen.getByRole('status', { name: 'Room activity' })).toHaveTextContent('Bob reacted ❤️');
  expect(mocks.community).toHaveBeenCalledTimes(1); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('failed metadata revalidation hides cached request and credit data and exposes explicit recovery', async () => {
  const view = show(); await screen.findByText('A requested song'); mocks.community.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => { await view.client.refetchQueries({ queryKey: ['social', 'viewer-1', 'room-community'] }); });
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
  expect(screen.queryByText('A requested song')).not.toBeInTheDocument();
  expect(screen.queryByText('Requested by Bob')).not.toBeInTheDocument();
  expect(await screen.findByText('A requested song')).toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
});

test('a delayed old-room result cannot relight the replacement room requests', async () => {
  let finish!: (value: { community: RoomCommunity }) => void;
  mocks.community.mockImplementation((viewerId: string, roomId: string) => roomId === 'room-a'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ community: { ...community(), roomId, requests: [], queueCredits: [] } }));
  const view = show(); await waitFor(() => expect(finish).toBeTypeOf('function'));
  mocks.state.room = { ...mocks.state.room!, roomId: 'room-b' }; view.rerender();
  await act(async () => { finish({ community: community() }); });
  expect(await screen.findByText('No pending song requests.')).toBeVisible();
  expect(screen.queryByText('A requested song')).not.toBeInTheDocument();
});
