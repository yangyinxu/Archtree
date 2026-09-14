import { roomFixture } from '../../test/roomFixture';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import type { RoomPlaybackOptions } from '../../player/roomPlayback';
import type { RoomSnapshot } from '../../api/rooms';

const mocks = vi.hoisted(() => ({
  getCurrentRoom: vi.fn(), getRealtimeTicket: vi.fn(), sendRoomCommand: vi.fn(), prepareRoomCommand: vi.fn(), getSocialOutcome: vi.fn(),
  attach: vi.fn(), apply: vi.fn(), detach: vi.fn(), pause: vi.fn(), resync: vi.fn(), correct: vi.fn()
}));
vi.mock('../../api/rooms', async importOriginal => ({ ...await importOriginal<typeof import('../../api/rooms')>(),
  getCurrentRoom: mocks.getCurrentRoom, getRealtimeTicket: mocks.getRealtimeTicket,
  prepareRoomCommand: mocks.prepareRoomCommand, sendRoomCommand: mocks.sendRoomCommand }));
vi.mock('../../api/social', async importOriginal => ({ ...await importOriginal<typeof import('../../api/social')>(), getSocialOutcome: mocks.getSocialOutcome }));
vi.mock('../../player', () => ({ playerStore: { attachRoomPlayback: mocks.attach } }));
import { roomSession } from './roomSession';

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Record<string, any>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: URL, readonly protocols: string[]) { Socket.instances.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value: unknown) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(value) }); }
}

let options: RoomPlaybackOptions;
beforeEach(() => {
  roomSession.stop(); vi.useFakeTimers(); vi.clearAllMocks(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  mocks.getCurrentRoom.mockResolvedValue({ room: null });
  mocks.getRealtimeTicket.mockResolvedValue({ ticket: 'single-use-ticket', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  mocks.prepareRoomCommand.mockImplementation(async (_viewer, action) => ({ ...action, commandId: 'immutable-command-123', scopeToken: 'original-scope-token-123' }));
  mocks.sendRoomCommand.mockResolvedValue({ commandId: 'immutable-command-123', outcome: 'applied', replayed: false });
  mocks.apply.mockResolvedValue(true);
  mocks.resync.mockResolvedValue(undefined);
  mocks.attach.mockImplementation((value: RoomPlaybackOptions) => {
    options = value;
    return { apply: mocks.apply, pauseLocally: mocks.pause, detach: mocks.detach, resync: mocks.resync, correct: mocks.correct };
  });
});
afterEach(() => { roomSession.stop(); vi.useRealTimers(); });
const connected = async (room: RoomSnapshot | null = roomFixture()) => {
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0];
  socket.receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  mocks.getCurrentRoom.mockResolvedValue({ room });
  await vi.dynamicImportSettled();
  return socket;
};

test('socket authentication keeps the single-use ticket out of the URL and readiness never emits a command', async () => {
  const socket = await connected();
  expect(socket.url.pathname).toBe('/api/social/v1/realtime');
  expect(socket.url.search).toBe('');
  expect(socket.protocols).toEqual(['archtree-room-v1', 'single-use-ticket']);
  expect(mocks.attach).toHaveBeenCalledTimes(1);
  expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'preparing', playbackAllowed: false }));
  options.onObservation?.({ type: 'ready', entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 });
  expect(socket.sent.find(message => message.type === 'ready')).toMatchObject({ report: {
    preparationId: 'prepare-a', sequence: 1, ready: true, memberId: 'member-a', controllerGeneration: 1
  } });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('late join uses current-timeline readiness and gates playback until own readiness is confirmed', async () => {
  const room = roomFixture(); room.preparation = null; room.timeline!.state = 'playing';
  const socket = await connected(room);
  expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'playing', playbackAllowed: false }));
  options.onObservation?.({ type: 'ready', entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 });
  expect(socket.sent.find(message => message.type === 'ready')?.report.preparationId).toBe('current');
  const ready = { ...room, revision: 2, members: room.members.map(member => ({ ...member, ready: true })) };
  socket.receive({ type: 'snapshot', room: ready });
  expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ playbackAllowed: true }));
  expect(mocks.attach).toHaveBeenCalledTimes(1);
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('concurrent or stale room clicks retain one immutable command and never auto-rebase', async () => {
  const socket = await connected();
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'playback_changed', replayed: false });
  await roomSession.control('next');
  const command = mocks.sendRoomCommand.mock.calls[0][1];
  expect(command).toMatchObject({ action: 'next', expectedPlaybackGeneration: 1, expectedControlGeneration: 1, expectedEntryId: 'entry-a' });
  socket.receive({ type: 'snapshot', room: { ...roomFixture(), revision: 2, timeline: { ...roomFixture().timeline!, playbackGeneration: 2 } } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
});

test('unknown mutation response requires an explicit original-key retry', async () => {
  await connected();
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Unknown', 'network'));
  await roomSession.control('next');
  const original = mocks.sendRoomCommand.mock.calls[0][1];
  expect(roomSession.getSnapshot().uncertain).toEqual(original);
  await roomSession.control('previous');
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
  await roomSession.retry();
  expect(mocks.sendRoomCommand.mock.calls[1][1]).toEqual(original);
  expect(mocks.prepareRoomCommand).toHaveBeenCalledTimes(1);
});

test('a definite disabled-feature rejection leaves room exit available', async () => {
  await connected();
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Disabled', 'http', 503, 'rooms_disabled'));
  await roomSession.control('next');
  expect(roomSession.getSnapshot().uncertain).toBeNull();
  await roomSession.run({ action: 'end', roomId: 'room-a', memberId: 'member-a' });
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(2);
});

test('local pause remains separate and Listen along sends its heartbeat before readiness', async () => {
  const socket = await connected();
  roomSession.pauseLocally();
  expect(mocks.pause).toHaveBeenCalledOnce();
  expect(roomSession.getSnapshot().locallyPaused).toBe(true);
  mocks.resync.mockImplementation(async () => options.onObservation?.({ type: 'ready', entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 }));
  socket.sent = [];
  await roomSession.resync();
  expect(socket.sent[0]).toMatchObject({ type: 'ping', heartbeat: { locallyPaused: false } });
  expect(socket.sent[1]).toMatchObject({ type: 'ready', report: { ready: true } });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('a local media suspension immediately updates its heartbeat without creating shared commands', async () => {
  const socket = await connected(); socket.sent = [];
  options.onObservation?.({ type: 'suspended', entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 });
  expect(socket.sent[0]).toMatchObject({ type: 'ping', heartbeat: { locallyPaused: true } });
  expect(socket.sent[1]).toMatchObject({ type: 'ready', report: { ready: false } });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('observers do not attach playback, and disconnect/account changes remove active playback immediately', async () => {
  const room = roomFixture(); room.self = { ...room.self, isController: false, canControl: false };
  const socket = await connected(room);
  expect(mocks.attach).not.toHaveBeenCalled();
  await roomSession.control('play'); expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  socket.receive({ type: 'snapshot', room: { ...roomFixture(), revision: 2 } });
  await vi.dynamicImportSettled();
  expect(mocks.attach).toHaveBeenCalledTimes(1);
  socket.close();
  expect(mocks.detach).toHaveBeenCalledOnce();
  expect(roomSession.getSnapshot().connected).toBe(false);
  advanceAccountEpoch();
  expect(roomSession.getSnapshot().room).toBeNull();
  expect(roomSession.getSnapshot().viewerId).toBe('');
});

test('stale snapshots and malformed private additions never overwrite the current authorized room', async () => {
  const socket = await connected({ ...roomFixture(), revision: 5 });
  socket.receive({ type: 'snapshot', room: { ...roomFixture(), revision: 2 } });
  expect(roomSession.getSnapshot().room?.revision).toBe(5);
  socket.receive({ type: 'snapshot', room: { ...roomFixture(), revision: 6, accountId: 'private' } });
  expect(roomSession.getSnapshot().connected).toBe(false);
  expect(mocks.detach).toHaveBeenCalledOnce();
});

test('an authoritative null fences a delayed HTTP room without emitting redundant heartbeat work', async () => {
  let resolve!: (value: { room: RoomSnapshot }) => void;
  mocks.getCurrentRoom.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0];
  socket.receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room: null });
  const count = socket.sent.length;
  socket.receive({ type: 'snapshot', room: null });
  expect(socket.sent).toHaveLength(count);
  resolve({ room: roomFixture() });
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().room).toBeNull();
  expect(mocks.attach).not.toHaveBeenCalled();
});

test('a slow WebSocket handshake is not replaced by another ticket every heartbeat', async () => {
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Socket.instances).toHaveLength(1);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(1);
});
