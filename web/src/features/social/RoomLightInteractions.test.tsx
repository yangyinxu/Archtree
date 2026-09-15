import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RoomCommand, RoomSnapshot } from '../../api/rooms';
import type { RoomCommunity, RoomCommunityEvent } from '../../api/roomCommunity';
import { roomFixture } from '../../test/roomFixture';
import { RoomLightInteractions } from './RoomLightInteractions';

const mocks = vi.hoisted(() => ({ run: vi.fn(), control: vi.fn(), state: {
  viewerId: 'viewer-1', room: null as RoomSnapshot | null, connected: true, busy: false, uncertain: null as RoomCommand | null
} }));
vi.mock('./roomSession', () => ({ roomSession: { getSnapshot: () => mocks.state, run: mocks.run, control: mocks.control }, useRoomSession: () => mocks.state }));
const actor = { socialId: `s_${'b'.repeat(32)}`, handle: 'bobby', alias: 'Bob', iconSeed: 'bob' };
const event = (eventId: string, kind: RoomCommunityEvent['kind'] = 'reaction', selectedActor: RoomCommunityEvent['actor'] = actor): RoomCommunityEvent => ({
  eventId, kind, actor: selectedActor, reaction: kind === 'reaction' ? 'heart' : null, createdAtMs: Date.now(), expiresAtMs: Date.now() + 30_000
});
const community = (events: RoomCommunityEvent[] = []): RoomCommunity => ({ roomId: 'room-a', epoch: 1, revision: 1, requests: [], queueCredits: [], events });
const show = (data: RoomCommunity | undefined = community(), updatedAt = 1) => {
  const content = (next: RoomCommunity | undefined, at: number) => <RoomLightInteractions viewerId="viewer-1" room={mocks.state.room!} community={next} updatedAt={at} />;
  const view = render(content(data, updatedAt));
  return { ...view, update(next = data, at = updatedAt) { data = next; updatedAt = at; view.rerender(content(data, updatedAt)); } };
};
const status = () => screen.getByRole('status', { name: 'Room activity' });
const list = () => screen.getByRole('list', { name: 'Room activity' });
beforeEach(() => {
  vi.clearAllMocks(); const room = roomFixture(); room.controlMode = 'hostOnly';
  room.members.push({ ...actor, memberId: 'member-b', role: 'guest', controllerGeneration: 1, connected: true, ready: true });
  mocks.state = { viewerId: 'viewer-1', room, connected: true, busy: false, uncertain: null }; mocks.run.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

test.each([false, true])('host-only guest observer=%s may send a fixed reaction without playback control', observer => {
  mocks.state.room!.self = { memberId: 'member-b', controllerGeneration: 1, isController: !observer, canControl: false };
  show(); expect(screen.getAllByRole('button')).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'Send heart' }));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ action: 'react', roomId: 'room-a', memberId: 'member-b', expectedEpoch: 1, reaction: 'heart' });
  expect(mocks.control).not.toHaveBeenCalled(); expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument();
});

test.each(['offline', 'closed', 'busy', 'uncertain'])('%s membership cannot create another reaction', condition => {
  if (condition === 'offline') mocks.state.connected = false;
  if (condition === 'closed') mocks.state.room!.status = 'ended';
  if (condition === 'busy') mocks.state.busy = true;
  if (condition === 'uncertain') mocks.state.uncertain = { action: 'react', roomId: 'room-a', memberId: 'member-a', expectedEpoch: 1, reaction: 'heart', scopeToken: 'original-scope', commandId: 'original-command' };
  show(); for (const button of screen.getAllByRole('button')) { expect(button).toBeDisabled(); fireEvent.click(button); }
  expect(mocks.run).not.toHaveBeenCalled();
});

test.each(['account', 'room', 'epoch', 'member'])('a stale displayed %s cannot send to a replacement membership', changed => {
  show(); const button = screen.getByRole('button', { name: 'Send applause' });
  if (changed === 'account') mocks.state.viewerId = 'viewer-2';
  else mocks.state.room = { ...mocks.state.room!, ...(changed === 'room' ? { roomId: 'room-b' } : changed === 'epoch' ? { epoch: 2 } : { self: { ...mocks.state.room!.self, memberId: 'member-new' } }) };
  fireEvent.click(button); expect(mocks.run).not.toHaveBeenCalled();
});

test('initial notices seed silently and only genuinely new live IDs are announced once', () => {
  const old = event('old', 'joined'); const view = show(community([old]));
  expect(within(list()).getByText('Bob joined the room.')).toBeVisible(); expect(status()).toBeEmptyDOMElement();
  const next = event('new', 'trackChanged'); view.update(community([old, next]), 2);
  expect(status()).toHaveTextContent('Bob changed the song.'); expect(status()).not.toHaveTextContent('joined');
  const capture = new MutationObserver(() => undefined); capture.observe(status(), { childList: true, characterData: true, subtree: true });
  view.update(community([old, next]), 3); expect(status()).toHaveTextContent('Bob changed the song.'); expect(capture.takeRecords()).toHaveLength(0); capture.disconnect();
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('live activity arriving before its roster waits for that revision and announces once', () => {
  const guest = mocks.state.room!.members.pop()!;
  const view = show(); const joined = { ...community([event('joined', 'joined')]), revision: 2 };
  view.update(joined, 2);
  expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument(); expect(status()).toBeEmptyDOMElement();
  mocks.state.room = { ...mocks.state.room!, revision: 2, members: [...mocks.state.room!.members, guest] };
  view.update();
  expect(status()).toHaveTextContent('Bob joined the room.');
  const capture = new MutationObserver(() => undefined); capture.observe(status(), { childList: true, characterData: true, subtree: true });
  view.update({ ...joined, revision: 3 }, 3);
  mocks.state.room = { ...mocks.state.room!, revision: 3 }; view.update();
  expect(status()).toHaveTextContent('Bob joined the room.'); expect(capture.takeRecords()).toHaveLength(0); capture.disconnect();
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test.each(['initial', 'reconnect'])('%s activity arriving before its roster remains a silent baseline', phase => {
  const guest = mocks.state.room!.members.pop()!;
  const joined = { ...community([event('baseline', 'joined')]), revision: 2 };
  const view = show(phase === 'initial' ? joined : community());
  if (phase === 'reconnect') {
    mocks.state.connected = false; view.update();
    mocks.state.connected = true; view.update();
    view.update(joined, 2);
  }
  mocks.state.room = { ...mocks.state.room!, revision: 2, members: [...mocks.state.room!.members, guest] }; view.update();
  expect(within(list()).getByText('Bob joined the room.')).toBeVisible(); expect(status()).toBeEmptyDOMElement();
  view.update({ ...joined, events: [...joined.events, event('live')] }, 3);
  expect(status()).toHaveTextContent('Bob reacted ❤️'); expect(status()).not.toHaveTextContent('joined');
});

test('a deferred event discarded by a newer departure roster cannot announce on a later rejoin', () => {
  const guest = mocks.state.room!.members.find(member => member.socialId === actor.socialId)!;
  const view = show(); const pending = { ...community([event('pending')]), revision: 2 };
  view.update(pending, 2); expect(status()).toBeEmptyDOMElement();
  mocks.state.room = { ...mocks.state.room!, revision: 3, members: mocks.state.room!.members.filter(member => member !== guest) }; view.update();
  expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument(); expect(status()).toBeEmptyDOMElement();
  mocks.state.room = { ...mocks.state.room!, revision: 4, members: [...mocks.state.room!.members, { ...guest, memberId: 'member-rejoined' }] }; view.update();
  expect(status()).toBeEmptyDOMElement();
});

test.each(['rejoin', 'rename'])('an old announcement stays retired when %s restores the same social card', change => {
  const guest = mocks.state.room!.members.find(member => member.socialId === actor.socialId)!;
  const view = show(); view.update(community([event('announced')]), 2);
  expect(status()).toHaveTextContent('Bob reacted ❤️');
  mocks.state.room = { ...mocks.state.room!, members: mocks.state.room!.members.flatMap(member => member !== guest
    ? [member] : change === 'rejoin' ? [] : [{ ...member, alias: 'New Bob' }]) }; view.update();
  expect(status()).toBeEmptyDOMElement();
  mocks.state.room = { ...mocks.state.room!, members: [mocks.state.room!.members[0],
    { ...guest, memberId: change === 'rejoin' ? 'member-rejoined' : guest.memberId }] }; view.update();
  expect(status()).toBeEmptyDOMElement();
});

test('offline and first reconnect response never replay retained or missed events as new announcements', () => {
  const old = event('old', 'joined'); const view = show(community([old]));
  const next = event('next'); view.update(community([old, next]), 2); expect(status()).toHaveTextContent('Bob reacted ❤️');
  mocks.state.connected = false; view.update(); expect(status()).toBeEmptyDOMElement();
  mocks.state.connected = true; view.update(); expect(status()).toBeEmptyDOMElement();
  const missed = event('missed', 'modeChanged'); view.update(community([old, next, missed]), 3);
  expect(within(list()).getByText('Bob changed playback control.')).toBeVisible(); expect(status()).toBeEmptyDOMElement();
  const live = event('live', 'hostChanged'); view.update(community([old, missed, live]), 4);
  expect(status()).toHaveTextContent('Bob became the host.'); expect(status()).not.toHaveTextContent('playback control');
});

test('distinct live IDs with identical text still generate separate announcements', () => {
  const view = show(); const first = event('heart-one'); view.update(community([first]), 2);
  const previousAnnouncement = status().firstElementChild; expect(status()).toHaveTextContent('Bob reacted ❤️');
  view.update(community([first, event('heart-two')]), 3);
  expect(status()).toHaveTextContent('Bob reacted ❤️'); expect(status().firstElementChild).not.toBe(previousAnnouncement);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});

test('current aliases replace stored aliases without announcing an old event again and departure removes all actor traces', () => {
  const view = show(); const current = event('live'); view.update(community([current]), 2);
  expect(status()).toHaveTextContent('Bob reacted ❤️');
  mocks.state.room = { ...mocks.state.room!, members: mocks.state.room!.members.map(member => member.socialId === actor.socialId ? { ...member, alias: 'New Bob' } : member) };
  view.update(); expect(within(list()).getByText('New Bob reacted ❤️')).toBeVisible(); expect(status()).toBeEmptyDOMElement();
  mocks.state.room = { ...mocks.state.room!, members: mocks.state.room!.members.filter(member => member.socialId !== actor.socialId) };
  view.update(); expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument(); expect(status()).toBeEmptyDOMElement();
});

test('event expiry and room closure clear activity locally without commands or extra fetches', () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); const value = event('short'); value.expiresAtMs = Date.now() + 100;
  const view = show(community([value, event('auto', 'trackChanged', null)]));
  expect(within(list()).getByText('The room advanced to the next song.')).toBeVisible();
  act(() => { vi.advanceTimersByTime(101); }); expect(within(list()).queryByText('Bob reacted ❤️')).not.toBeInTheDocument();
  mocks.state.room = { ...mocks.state.room!, status: 'ended' }; view.update();
  expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument(); expect(status()).toBeEmptyDOMElement(); expect(mocks.run).not.toHaveBeenCalled();
});

test('wrong-authority data is hidden and newly rendered membership does not reuse old announcements', () => {
  const view = show(); view.update(community([event('live')]), 2); expect(status()).toHaveTextContent('Bob reacted ❤️');
  mocks.state.room = { ...mocks.state.room!, epoch: 2 }; view.update();
  expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument(); expect(status()).toBeEmptyDOMElement();
  view.update({ ...community([event('live')]), epoch: 2 }, 3); expect(status()).toBeEmptyDOMElement();
});
