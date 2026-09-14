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
  autoPong = true;
  sent: Record<string, any>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: URL, readonly protocols: string[]) { Socket.instances.push(this); }
  send(value: string) {
    const message = JSON.parse(value); this.sent.push(message);
    if (this.autoPong && message.type === 'ping') void Promise.resolve().then(() => this.acknowledge(message));
  }
  acknowledge(message: Record<string, any>) {
    this.receive({ type: 'pong', clientTimeMs: message.clientTimeMs, serverTimeMs: 1_000_000 + message.clientTimeMs });
  }
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
afterEach(() => { roomSession.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const connected = async (room: RoomSnapshot | null = roomFixture()) => {
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0];
  socket.receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  mocks.getCurrentRoom.mockResolvedValue({ room });
  await vi.dynamicImportSettled();
  return socket;
};
const pausedRoom = () => {
  const room = roomFixture(); room.preparation = null; room.timeline!.state = 'paused'; return room;
};
/** Holds one real asynchronous boundary without advancing unrelated timers. */
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const playIntent = () => ({ type: 'play' as const, expectedRoomId: 'room-a', expectedEpoch: 1,
  expectedEntryId: 'entry-a', expectedPlaybackEpoch: 1, expectedControlEpoch: 1, expectedQueueRevision: 1 });

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

test('global consumers reuse one transport and subscription refreshes invitations missed during connection', async () => {
  const first = vi.fn(); const global = vi.fn();
  roomSession.ensure('viewer-1', first);
  roomSession.ensure('viewer-1', global);
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
  Socket.instances[0].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room: null });
  expect(global).toHaveBeenCalledExactlyOnceWith('social');
  Socket.instances[0].receive({ type: 'socialChanged' });
  expect(global).toHaveBeenCalledTimes(2);
  expect(first).not.toHaveBeenCalled();
  expect(mocks.attach).not.toHaveBeenCalled(); expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('disabled rooms allow an explicit invitation decline without background ticket attempts', async () => {
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: false });
  await vi.advanceTimersByTimeAsync(16_000);
  expect(mocks.getRealtimeTicket).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(0);
  await roomSession.run({ action: 'declineInvitation', invitationId: 'invitation-a', generation: 2 });
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining({ action: 'declineInvitation', generation: 2 }));
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
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

test('one-click Play confirms its resumed heartbeat before preparing or sending the original command', async () => {
  const socket = await connected(pausedRoom());
  roomSession.pauseLocally(); socket.autoPong = false; socket.sent = [];
  const playing = roomSession.control('play');
  expect(roomSession.getSnapshot()).toMatchObject({ busy: true, locallyPaused: false });
  expect(socket.sent[0]).toMatchObject({ type: 'ping', heartbeat: { locallyPaused: false } });
  expect(mocks.resync).not.toHaveBeenCalled();
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  socket.acknowledge(socket.sent[0]);
  await playing;
  expect(mocks.resync).toHaveBeenCalledOnce();
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.sendRoomCommand.mock.calls[0][1]).toMatchObject({ action: 'play', expectedEntryId: 'entry-a',
    expectedPlaybackGeneration: 1, expectedControlGeneration: 1, expectedQueueRevision: 1, controllerGeneration: 1 });
  expect(roomSession.getSnapshot().busy).toBe(false);
});

test.each(['queue', 'control', 'controller', 'playback'] as const)('a changed %s while Play waits for heartbeat cannot rebase or dispatch the gesture', async change => {
  const room = pausedRoom(); const socket = await connected(room); socket.autoPong = false;
  roomSession.pauseLocally();
  const playing = roomSession.control('play');
  const resumeHeartbeat = socket.sent.at(-1)!;
  const updated = structuredClone(room); updated.revision += 1;
  if (change === 'queue') updated.queueRevision += 1;
  if (change === 'control') updated.controlGeneration += 1;
  if (change === 'controller') {
    updated.self.controllerGeneration += 1;
    updated.members[0].controllerGeneration += 1;
  }
  if (change === 'playback') updated.timeline!.playbackGeneration += 1;
  socket.receive({ type: 'snapshot', room: updated });
  socket.acknowledge(resumeHeartbeat); await playing;
  expect(roomSession.getSnapshot().error).toBe('social.stale');
  expect(roomSession.getSnapshot().locallyPaused).toBe(true);
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  expect(mocks.resync).not.toHaveBeenCalled();
});

test('a membership-only revision during Play readiness retains the observed control preconditions', async () => {
  const room = pausedRoom(); const socket = await connected(room); socket.autoPong = false;
  const playing = roomSession.control('play'); const resumeHeartbeat = socket.sent.at(-1)!;
  socket.receive({ type: 'snapshot', room: { ...room, revision: 2, members: room.members.map(member => ({ ...member, ready: true })) } });
  socket.acknowledge(resumeHeartbeat); await playing;
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.sendRoomCommand.mock.calls[0][1]).toMatchObject({ expectedPlaybackGeneration: 1, expectedControlGeneration: 1,
    expectedQueueRevision: 1, controllerGeneration: 1, expectedEntryId: 'entry-a' });
});

test('local Pause during the heartbeat wait cancels Play without starting local media or sending a command', async () => {
  const socket = await connected(pausedRoom()); socket.autoPong = false;
  const playing = roomSession.control('play'); const resumeHeartbeat = socket.sent.at(-1)!;
  roomSession.pauseLocally(); socket.acknowledge(resumeHeartbeat); await playing;
  expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: true, busy: false });
  expect(mocks.resync).not.toHaveBeenCalled();
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test.each(['local-pause', 'freeze', 'control-change'] as const)('%s while the Play scope is pending cancels continuation without replacing its preconditions', async interruption => {
  const room = pausedRoom(); const socket = await connected(room);
  roomSession.pauseLocally();
  const scope = deferred<Record<string, unknown>>(); mocks.prepareRoomCommand.mockReturnValueOnce(scope.promise);
  const playing = roomSession.control('play'); await vi.advanceTimersByTimeAsync(0);
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
  const captured = { ...mocks.prepareRoomCommand.mock.calls[0][1] };
  if (interruption === 'local-pause') roomSession.pauseLocally();
  else if (interruption === 'freeze') document.dispatchEvent(new Event('freeze'));
  else socket.receive({ type: 'snapshot', room: { ...room, revision: 2, controlGeneration: 2 } });
  scope.resolve({ ...captured, commandId: 'held-command', scopeToken: 'held-scope' }); await playing;
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.prepareRoomCommand.mock.calls[0][1]).toEqual(captured);
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  expect(roomSession.getSnapshot().busy).toBe(false);
  expect(roomSession.getSnapshot().locallyPaused).toBe(true);
});

test('scope rejection before Play dispatch restores the original device pause and leaves recovery available', async () => {
  const socket = await connected(pausedRoom()); roomSession.pauseLocally();
  mocks.prepareRoomCommand.mockRejectedValueOnce(new ApiError('Scope quota', 'http', 429, 'social_limit'));
  await roomSession.control('play');
  expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: true, busy: false, uncertain: null });
  expect(socket.sent.at(-1)).toMatchObject({ type: 'ready', report: { ready: false } });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  expect(mocks.pause).toHaveBeenCalledTimes(2);
});

test('a Next scope completing after freeze cannot dispatch or automatically resume after fresh authentication', async () => {
  const room = pausedRoom(); await connected(room);
  const scope = deferred<Record<string, unknown>>(); mocks.prepareRoomCommand.mockReturnValueOnce(scope.promise);
  const next = roomSession.control('next'); await vi.advanceTimersByTimeAsync(0);
  const captured = { ...mocks.prepareRoomCommand.mock.calls[0][1] };
  document.dispatchEvent(new Event('freeze'));
  scope.resolve({ ...captured, commandId: 'held-next', scopeToken: 'held-scope' }); await next;
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  Socket.instances[1].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
  expect(roomSession.getSnapshot()).toMatchObject({ busy: false, locallyPaused: true, uncertain: null });
});

test('a second Play during readiness is ignored and the first gesture sends exactly one command', async () => {
  const socket = await connected(pausedRoom()); socket.autoPong = false;
  const first = roomSession.control('play'); const resumeHeartbeat = socket.sent.at(-1)!;
  const second = roomSession.control('play');
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  socket.acknowledge(resumeHeartbeat); await Promise.all([first, second]);
  expect(mocks.resync).toHaveBeenCalledOnce();
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
});

test('missing heartbeat acknowledgement times out without dispatching Play or hanging the busy state', async () => {
  const socket = await connected(pausedRoom()); socket.autoPong = false;
  const playing = roomSession.control('play');
  await vi.advanceTimersByTimeAsync(3000); await playing;
  expect(roomSession.getSnapshot()).toMatchObject({ busy: false, connected: false, locallyPaused: true });
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  expect(mocks.detach).toHaveBeenCalledOnce();
});

test.each(['paused', 'playing'] as const)('guest global Play on a %s room resumes this device without a shared command', async status => {
  const room = pausedRoom(); room.timeline!.state = status; room.controlMode = 'hostOnly';
  room.self.canControl = false; room.members[0].role = 'guest'; room.hostMemberId = 'another-host';
  await connected(room); roomSession.pauseLocally();
  options.onIntent(playIntent()); await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().locallyPaused).toBe(false);
  expect(mocks.resync).toHaveBeenCalledOnce();
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('authorized global Play on an already-playing timeline is only personal resync', async () => {
  const room = pausedRoom(); room.timeline!.state = 'playing'; await connected(room); roomSession.pauseLocally();
  options.onIntent(playIntent()); await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().locallyPaused).toBe(false);
  expect(mocks.resync).toHaveBeenCalledOnce();
  expect(mocks.prepareRoomCommand).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test.each(['freeze', 'pagehide'] as const)('%s revokes authority even when already locally paused, and return authenticates without resuming', async event => {
  const room = pausedRoom(); const socket = await connected(room); roomSession.pauseLocally();
  (event === 'freeze' ? document : window).dispatchEvent(new Event(event));
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, locallyPaused: true });
  expect(mocks.detach).toHaveBeenCalledOnce();
  socket.receive({ type: 'snapshot', room: { ...room, revision: 5 } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(Socket.instances).toHaveLength(1);
  expect(roomSession.getSnapshot().room?.revision).toBe(1);
  (event === 'freeze' ? document : window).dispatchEvent(new Event(event === 'freeze' ? 'resume' : 'pageshow'));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
  const resumed = Socket.instances[1];
  expect(roomSession.getSnapshot().connected).toBe(false);
  resumed.receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_005_000, room });
  await vi.dynamicImportSettled();
  expect(roomSession.getSnapshot()).toMatchObject({ connected: true, locallyPaused: true });
  expect(mocks.attach).toHaveBeenCalledTimes(2);
  expect(mocks.pause).toHaveBeenCalledTimes(2);
  expect(mocks.resync).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('a ticket issued before freeze cannot open a socket after its transport authority is invalidated', async () => {
  const ticket = deferred<{ ticket: string; expiresAt: string }>(); mocks.getRealtimeTicket.mockReturnValueOnce(ticket.promise);
  roomSession.ensure('viewer-1', vi.fn()); await vi.advanceTimersByTimeAsync(0);
  document.dispatchEvent(new Event('freeze'));
  ticket.resolve({ ticket: 'stale-ticket-must-not-open', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  await vi.advanceTimersByTimeAsync(0); expect(Socket.instances).toHaveLength(0);
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].protocols).toEqual(['archtree-room-v1', 'single-use-ticket']);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
});

test('a room read started before pagehide cannot resurrect room access after suspension', async () => {
  await connected(null);
  const read = deferred<{ room: RoomSnapshot }>(); mocks.getCurrentRoom.mockReturnValueOnce(read.promise);
  const refresh = roomSession.refresh(); window.dispatchEvent(new Event('pagehide'));
  read.resolve({ room: roomFixture() }); await refresh;
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, room: null });
  expect(mocks.attach).not.toHaveBeenCalled();
});

test('a stale room read failure cannot replace a fresh authorized connection with an old error', async () => {
  const room = pausedRoom(); await connected(room);
  const read = deferred<never>(); mocks.getCurrentRoom.mockReturnValueOnce(read.promise);
  const refresh = roomSession.refresh(); document.dispatchEvent(new Event('freeze'));
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  Socket.instances[1].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  read.reject(new ApiError('Old read failed', 'network')); await refresh;
  expect(roomSession.getSnapshot()).toMatchObject({ connected: true, error: null, locallyPaused: true });
});

test('frames and close callbacks from an old socket cannot replace fresh authenticated room state', async () => {
  const previous = await connected(); document.dispatchEvent(new Event('freeze'));
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  const resumed = Socket.instances[1];
  resumed.receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room: null });
  previous.receive({ type: 'snapshot', room: { ...roomFixture(), revision: 99 } }); previous.close();
  expect(roomSession.getSnapshot()).toMatchObject({ connected: true, room: null });
  expect(mocks.attach).toHaveBeenCalledOnce();
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
});

test('foreground return detects stale wall time even when the monotonic clock did not advance', async () => {
  await connected();
  const monotonic = performance.now(); vi.setSystemTime(Date.now() + 16_000);
  expect(performance.now()).toBe(monotonic);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, locallyPaused: true });
  expect(mocks.detach).toHaveBeenCalledOnce();
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
  expect(mocks.resync).not.toHaveBeenCalled();
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('freeze preserves an in-flight uncertain mutation identity without automatically replaying it after return', async () => {
  const room = pausedRoom(); await connected(room);
  const response = deferred<never>(); mocks.sendRoomCommand.mockReturnValueOnce(response.promise);
  const mutation = roomSession.control('next'); await vi.advanceTimersByTimeAsync(0);
  const original = mocks.sendRoomCommand.mock.calls[0][1];
  document.dispatchEvent(new Event('freeze'));
  response.reject(new ApiError('Commit response lost', 'network')); await mutation;
  expect(roomSession.getSnapshot()).toMatchObject({ busy: false, connected: false, uncertain: original });
  await vi.advanceTimersByTimeAsync(5000);
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  Socket.instances[1].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_005_000, room });
  await vi.advanceTimersByTimeAsync(5000);
  expect(roomSession.getSnapshot().uncertain).toEqual(original);
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.resync).not.toHaveBeenCalled();
});

test('an uncertain playback retry stays pending offline and uses its original identity only after fresh authorization', async () => {
  const room = pausedRoom(); await connected(room);
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Unknown result', 'network'));
  await roomSession.control('next'); const original = mocks.sendRoomCommand.mock.calls[0][1];
  document.dispatchEvent(new Event('freeze')); await roomSession.retry();
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  expect(roomSession.getSnapshot().uncertain).toEqual(original);
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().connected).toBe(false);
  await roomSession.retry(); expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  Socket.instances[1].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  await roomSession.retry();
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(2);
  expect(mocks.sendRoomCommand.mock.calls[1][1]).toEqual(original);
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
});

test.each(['leave', 'end', 'declineInvitation'] as const)('%s remains available without live playback authority', async action => {
  await connected(); document.dispatchEvent(new Event('freeze'));
  await roomSession.run(action === 'declineInvitation' ? { action, invitationId: 'invite-a', generation: 1 }
    : { action, roomId: 'room-a', memberId: 'member-a' });
  expect(mocks.sendRoomCommand).toHaveBeenCalledOnce();
  expect(mocks.sendRoomCommand.mock.calls[0][1].action).toBe(action);
  expect(roomSession.getSnapshot().connected).toBe(false);
});

test('an uncertain End retry remains available offline with the same command identity', async () => {
  await connected(); mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('End response lost', 'network'));
  await roomSession.run({ action: 'end', roomId: 'room-a', memberId: 'member-a' });
  const original = mocks.sendRoomCommand.mock.calls[0][1];
  document.dispatchEvent(new Event('freeze')); await roomSession.retry();
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(2);
  expect(mocks.sendRoomCommand.mock.calls[1][1]).toEqual(original);
  expect(mocks.prepareRoomCommand).toHaveBeenCalledOnce();
});
