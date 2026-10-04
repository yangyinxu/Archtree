import { act, render, screen } from '@testing-library/react';
import type { RoomSnapshot } from '../../api/rooms';
import { roomFixture } from '../../test/roomFixture';
import RoomDeadline from './RoomDeadline';

const session = vi.hoisted(() => ({ connected: true, room: null as RoomSnapshot | null, roomReceivedAtMs: 0 }));
vi.mock('./roomSession', () => ({ useRoomSession: () => ({ ...session }) }));

/** Mirrors the room session accepting a snapshot: the room and its monotonic receipt time change together. */
const accept = (room: RoomSnapshot) => { session.room = room; session.roomReceivedAtMs = performance.now(); };
// A fresh element per render: React would bail out of re-rendering an identical element.
const host = () => <RoomDeadline kind="host" />;
const transfer = () => <RoomDeadline kind="transfer" />;

/** The viewer is a connected guest; the separate host membership has lost its controller. */
const guestView = (change: Partial<RoomSnapshot> = {}): RoomSnapshot => {
  const fixture = roomFixture();
  return { ...fixture, hostMemberId: 'host-member', preparation: null,
    members: [...fixture.members, { ...fixture.members[0], memberId: 'host-member', role: 'host', connected: false }], ...change };
};
/** The viewer is the host; `isController: false` models an observing tab or device. */
const hostView = (isController: boolean, change: Partial<RoomSnapshot> = {}): RoomSnapshot => {
  const fixture = roomFixture();
  return { ...fixture, preparation: null, self: { ...fixture.self, isController }, ...change };
};
const advance = (milliseconds: number) => act(() => { vi.advanceTimersByTime(milliseconds); });

beforeEach(() => {
  session.connected = true; session.room = null; session.roomReceivedAtMs = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(() => { vi.useRealTimers(); });

test('a guest counts the host grace down from the snapshot server time, independent of the device wall clock', () => {
  // The device wall clock is years away from the fixture's server time; only monotonic elapsed time counts.
  vi.setSystemTime(new Date('2031-06-01T00:00:00Z'));
  accept(guestView({ hostAbsenceDeadlineMs: 1_020_000 })); render(host());
  const timer = screen.getByRole('timer');
  expect(timer).toHaveTextContent('The host is disconnected. Shared playback will be suspended in 0:20 unless the host returns.');
  advance(999); expect(timer).toHaveTextContent('in 0:20 unless');
  advance(1); expect(timer).toHaveTextContent('in 0:19 unless');
  advance(19_000); expect(timer).toHaveTextContent('in 0:00 unless');
  // At zero the display stops; the server sweep, not the client, suspends the room.
  expect(vi.getTimerCount()).toBe(0);
  advance(10_000); expect(timer).toHaveTextContent('in 0:00 unless');
});

test('a newer snapshot re-bases the countdown on its own server time', () => {
  const room = guestView({ hostAbsenceDeadlineMs: 1_020_000 });
  accept(room); const { rerender } = render(host());
  advance(5_000);
  expect(screen.getByRole('timer')).toHaveTextContent('in 0:15 unless');
  // For example after device sleep paused the monotonic clock: the server observed ten seconds, not five.
  accept({ ...room, revision: 2, serverTimeMs: 1_010_000 }); rerender(host());
  expect(screen.getByRole('timer')).toHaveTextContent('in 0:10 unless');
});

test('remounting, or mounting late, counts from when the session accepted the snapshot rather than from mount', () => {
  // Snapshots arrive only on change, so leaving Together and returning keeps the same session snapshot.
  accept(guestView({ status: 'suspended', hostAbsenceDeadlineMs: 1_000_000 }));
  const { unmount } = render(host());
  expect(screen.getByRole('timer')).toHaveTextContent('The room ends in 4:30 unless');
  advance(60_000);
  expect(screen.getByRole('timer')).toHaveTextContent('The room ends in 3:30 unless');
  unmount();
  advance(120_000);
  render(host());
  expect(screen.getByRole('timer')).toHaveTextContent('The room ends in 1:30 unless');
});

test('a transfer countdown first rendered after the snapshot arrived shows only the remaining time', () => {
  // For example while the lazily loaded deadline chunk was still downloading.
  accept(guestView({ transferOffer: { offerId: 'offer-a', targetMemberId: 'member-a', targetControllerGeneration: 1, expiresAtMs: 1_030_000 } }));
  advance(12_000);
  render(transfer());
  expect(screen.getByRole('timer')).toHaveTextContent('This offer expires in 0:18.');
});

test('without a room the deadline slots render nothing', () => {
  const { container, rerender } = render(host());
  expect(container).toBeEmptyDOMElement();
  rerender(transfer());
  expect(container).toBeEmptyDOMElement();
});

test('a suspended room counts down to closure five minutes after the host absence began', () => {
  // The grace ended 10 s ago, so absence began 40 s ago and the room ends 260 s from now.
  accept(guestView({ status: 'suspended', hostAbsenceDeadlineMs: 990_000 })); render(host());
  expect(screen.getByRole('timer')).toHaveTextContent('Shared playback is suspended. The room ends in 4:20 unless the host returns.');
  advance(260_000);
  expect(screen.getByRole('timer')).toHaveTextContent('The room ends in 0:00 unless');
});

test('after the host returns, a suspended room says that only the host starts playback again', () => {
  accept(guestView({ status: 'suspended' })); const { rerender, container } = render(host());
  expect(screen.getByText('Shared playback is suspended until the host starts it again.')).toBeVisible();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  accept(hostView(true, { status: 'suspended' })); rerender(host());
  expect(screen.getByText('Shared playback is suspended. Start playback for everyone when you are ready.')).toBeVisible();
  accept(guestView()); rerender(host());
  expect(container).toBeEmptyDOMElement();
});

test('the host sees its own disconnected device, while its connected controller hides a just-recorded absence', () => {
  accept(hostView(false, { hostAbsenceDeadlineMs: 1_010_000 })); const { rerender, container } = render(host());
  expect(screen.getByRole('timer')).toHaveTextContent('Your playing device is disconnected. Shared playback will be suspended in 0:10 unless it reconnects.');
  accept(hostView(false, { status: 'suspended', hostAbsenceDeadlineMs: 1_000_000 })); rerender(host());
  expect(screen.getByRole('timer')).toHaveTextContent('Shared playback is suspended. The room ends in 4:30 unless your playing device reconnects.');
  // Use this device records absence until the new controller's first heartbeat arrives.
  accept(hostView(true, { hostAbsenceDeadlineMs: 1_030_000 })); rerender(host());
  expect(container).toBeEmptyDOMElement();
  accept(hostView(true, { status: 'suspended', hostAbsenceDeadlineMs: 1_030_000 })); rerender(host());
  expect(screen.getByText('Shared playback is suspended. Start playback for everyone when you are ready.')).toBeVisible();
  session.connected = false;
  accept(hostView(true, { hostAbsenceDeadlineMs: 1_030_000 })); rerender(host());
  expect(screen.getByRole('timer')).toHaveTextContent('Your playing device is disconnected. Shared playback will be suspended in 0:30 unless it reconnects.');
});

test('a transfer offer shows the same server expiry to its recipient and to the host', () => {
  const offer = { offerId: 'offer-a', targetMemberId: 'member-a', targetControllerGeneration: 1, expiresAtMs: 1_030_000 };
  accept(guestView({ transferOffer: offer })); const { rerender, container } = render(transfer());
  expect(container).toHaveTextContent('The host offered you the host role. If you accept, the current host leaves the room.');
  expect(screen.getByRole('timer')).toHaveTextContent('This offer expires in 0:30.');
  advance(30_000);
  expect(screen.getByRole('timer')).toHaveTextContent('This offer expires in 0:00.');
  accept(hostView(true, { serverTimeMs: 1_030_000,
    transferOffer: { ...offer, targetMemberId: 'guest-member', expiresAtMs: 1_042_000 } })); rerender(transfer());
  expect(container).toHaveTextContent('Waiting for acceptance. The current host leaves when the transfer is accepted.');
  expect(screen.getByRole('timer')).toHaveTextContent('This offer expires in 0:12.');
  accept(hostView(true)); rerender(transfer());
  expect(container).toBeEmptyDOMElement();
});

test('an ended room keeps its terminal message without a countdown', () => {
  accept(guestView({ status: 'ended', hostAbsenceDeadlineMs: 1_020_000 })); render(host());
  expect(screen.getByText('This room has ended.')).toBeVisible();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
});
