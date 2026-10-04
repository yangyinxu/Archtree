import { roomFixture } from '../../test/roomFixture';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import type { RoomPlaybackOptions } from '../../player/roomPlayback';
import type { RoomAction, RoomSnapshot } from '../../api/rooms';
import { createPlayerStore } from '../../player/playerStore';
import type { PlayerAudio } from '../../player/types';

const mocks = vi.hoisted(() => ({
  getCurrentRoom: vi.fn(), getRealtimeTicket: vi.fn(), sendRoomCommand: vi.fn(), prepareRoomCommand: vi.fn(), getSocialOutcome: vi.fn(),
  attach: vi.fn(), apply: vi.fn(), detach: vi.fn(), pause: vi.fn(), resync: vi.fn(), correct: vi.fn(), playbackIntent: vi.fn()
}));
vi.mock('../../api/rooms', async importOriginal => ({ ...await importOriginal<typeof import('../../api/rooms')>(),
  getCurrentRoom: mocks.getCurrentRoom, getRealtimeTicket: mocks.getRealtimeTicket,
  prepareRoomCommand: mocks.prepareRoomCommand, sendRoomCommand: mocks.sendRoomCommand }));
vi.mock('../../api/social', async importOriginal => ({ ...await importOriginal<typeof import('../../api/social')>(), getSocialOutcome: mocks.getSocialOutcome }));
vi.mock('../../player', () => ({ playerStore: { attachRoomPlayback: mocks.attach, notePlaybackIntent: mocks.playbackIntent } }));
/** Lets a test switch accounts while the on-demand refusal copy is being applied. */
const refusalHook = vi.hoisted(() => ({ beforeExplain: undefined as undefined | (() => void) }));
vi.mock('./socialRefusal', async importOriginal => {
  const actual = await importOriginal<typeof import('./socialRefusal')>();
  return { ...actual, roomRefusalMessage: (...args: Parameters<typeof actual.roomRefusalMessage>) => {
    refusalHook.beforeExplain?.(); return actual.roomRefusalMessage(...args);
  } };
});
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

/** Real player-store events expose readiness loss after native media failure. */
class RoomMedia implements PlayerAudio {
  src = ''; currentSrc = ''; currentTime = 0; duration = 120; readyState = 0;
  volume = 1; muted = false; paused = true; ended = false; playbackRate = 1;
  error: { code: number } | null = null;
  loadCalls = 0; playCalls = 0;
  listeners = new Map<string, Set<() => void>>();
  async play() { this.playCalls++; this.paused = false; this.emit('play'); this.emit('playing'); }
  pause() { this.paused = true; this.emit('pause'); }
  load() { this.loadCalls++; this.readyState = 0; this.currentSrc = ''; this.error = null; this.emit('loadstart'); }
  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { this.listeners.get(type)?.forEach(listener => listener()); }
  ready() { this.currentSrc = this.src; this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); }
}

let options: RoomPlaybackOptions;
beforeEach(() => {
  roomSession.stop(); vi.useFakeTimers(); vi.clearAllMocks(); Socket.instances = []; refusalHook.beforeExplain = undefined;
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

test('snapshot/readiness/reaction callbacks never claim listening ownership while explicit play and resync mark their intent', async () => {
  const room = pausedRoom(); const socket = await connected(room);
  options.onObservation?.({ type: 'actual-start', entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 });
  socket.receive({ type: 'snapshot', room: { ...room, revision: 2 } });
  await roomSession.run({ action: 'react', roomId: room.roomId, memberId: room.self.memberId, expectedEpoch: room.epoch, reaction: 'heart' });
  expect(mocks.playbackIntent).not.toHaveBeenCalled();
  await roomSession.control('play');
  expect(mocks.playbackIntent).toHaveBeenCalledTimes(1);
  await roomSession.resync(); expect(mocks.playbackIntent).toHaveBeenCalledTimes(2);
});

test('an observer reaction is an explicit community intent and cannot emit playback commands or refetch social lists', async () => {
  const room = roomFixture(); room.self.isController = false; room.self.canControl = false;
  await connected(room); const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  const before = JSON.stringify(room);
  await roomSession.run({ action: 'react', roomId: room.roomId, memberId: room.self.memberId, expectedEpoch: room.epoch, reaction: 'heart' });
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining({ action: 'react', reaction: 'heart' }));
  expect(refresh).toHaveBeenCalledExactlyOnceWith('community');
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(JSON.stringify(roomSession.getSnapshot().room)).toBe(before);
});

test('each accepted snapshot records its monotonic receipt time so countdowns survive remounts', async () => {
  const room = pausedRoom();
  const beforeSubscribe = performance.now();
  const socket = await connected(room);
  const first = roomSession.getSnapshot().roomReceivedAtMs;
  expect(first).toBeGreaterThanOrEqual(beforeSubscribe);
  expect(first).toBeLessThanOrEqual(performance.now());
  const now = vi.spyOn(performance, 'now').mockReturnValue(first + 60_000);
  socket.receive({ type: 'snapshot', room: { ...room, revision: 3 } });
  expect(roomSession.getSnapshot()).toMatchObject({ room: { revision: 3 }, roomReceivedAtMs: first + 60_000 });
  // A delayed older revision is rejected, so it cannot re-date the snapshot that is still current.
  now.mockReturnValue(first + 90_000);
  socket.receive({ type: 'snapshot', room: { ...room, revision: 2 } });
  expect(roomSession.getSnapshot()).toMatchObject({ room: { revision: 3 }, roomReceivedAtMs: first + 60_000 });
  now.mockRestore();
  roomSession.stop();
  expect(roomSession.getSnapshot()).toMatchObject({ room: null, roomReceivedAtMs: 0 });
});

test.each(['play', 'pause', 'seek', 'select', 'next', 'previous'] as const)('%s settlement applies the authoritative projection without waking invitation or community queries again', async action => {
  const room = pausedRoom(); await connected(room);
  const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  const updated = structuredClone(room); updated.revision = 2; updated.timeline!.positionMs = 1000;
  mocks.getCurrentRoom.mockResolvedValue({ room: updated });
  const beforeReads = mocks.getCurrentRoom.mock.calls.length;
  await roomSession.control(action, action === 'select' ? 'entry-a' : 1);
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining({ action }));
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(beforeReads + 1);
  expect(roomSession.getSnapshot().room).toEqual(updated);
  expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, positionSeconds: 1 }));
  expect(refresh).not.toHaveBeenCalled();
});

test.each<RoomAction>([
  { action: 'invite', roomId: 'room-a', memberId: 'member-a', targetSocialId: `s_${'b'.repeat(32)}` },
  { action: 'declineInvitation', invitationId: 'invitation-a', generation: 1 },
  { action: 'leave', roomId: 'room-a', memberId: 'member-a' },
  { action: 'end', roomId: 'room-a', memberId: 'member-a' },
  { action: 'offerTransfer', roomId: 'room-a', memberId: 'member-a', expectedControlGeneration: 1,
    targetMemberId: 'member-b', targetControllerGeneration: 1 }
])('$action settlement retains room-surface invalidation after reconciliation', async action => {
  await connected(pausedRoom());
  const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  const beforeReads = mocks.getCurrentRoom.mock.calls.length;
  await roomSession.run(action);
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining(action));
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(beforeReads + 1);
  expect(refresh).toHaveBeenCalledExactlyOnceWith('rooms');
});

test.each(['react', 'requestSong', 'dismissSongRequest', 'acceptSongRequest', 'removeQueueEntry', 'reorderQueue'] as const)('%s settlement retains its immediate community invalidation', async action => {
  const room = pausedRoom(); await connected(room);
  const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  const control = { ...member, controllerGeneration: 1, expectedEpoch: 1, expectedEntryId: 'entry-a',
    expectedPlaybackGeneration: 1, expectedControlGeneration: 1, expectedQueueRevision: 1 };
  const commands: Record<typeof action, RoomAction> = {
    react: { ...member, action: 'react', expectedEpoch: 1, reaction: 'heart' },
    requestSong: { ...member, action: 'requestSong', expectedEpoch: 1, mediaTrackId: '1'.repeat(24) },
    dismissSongRequest: { ...member, action: 'dismissSongRequest', requestId: 'request-a' },
    acceptSongRequest: { ...control, action: 'acceptSongRequest', requestId: 'request-a' },
    removeQueueEntry: { ...control, action: 'removeQueueEntry', targetEntryId: 'entry-b' },
    reorderQueue: { ...control, action: 'reorderQueue', entryIds: ['entry-a'] }
  };
  const beforeReads = mocks.getCurrentRoom.mock.calls.length;
  await roomSession.run(commands[action]);
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining({ action }));
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(beforeReads + 1);
  expect(refresh).toHaveBeenCalledExactlyOnceWith('community');
});

test('explicit outcome recovery retains conservative room-surface invalidation for a transport command', async () => {
  await connected(pausedRoom());
  const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Unknown', 'network'));
  await roomSession.control('next');
  const original = roomSession.getSnapshot().uncertain!;
  expect(original.action).toBe('next'); expect(refresh).not.toHaveBeenCalled();
  const updated = { ...pausedRoom(), revision: 2 };
  mocks.getCurrentRoom.mockResolvedValue({ room: updated });
  mocks.getSocialOutcome.mockResolvedValue({ outcome: { commandId: original.commandId, outcome: 'applied', replayed: true } });
  const beforeReads = mocks.getCurrentRoom.mock.calls.length;
  await roomSession.checkOutcome();
  expect(mocks.getSocialOutcome).toHaveBeenCalledExactlyOnceWith('viewer-1', original);
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(beforeReads + 1);
  expect(roomSession.getSnapshot()).toMatchObject({ room: updated, uncertain: null, busy: false });
  expect(refresh).toHaveBeenCalledExactlyOnceWith('rooms');
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
});

test('reaction quota rejections retain no resend intent and explain the temporary limit', async () => {
  await connected();
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'room_reaction_limit', replayed: false });
  const room = roomSession.getSnapshot().room!;
  await roomSession.run({ action: 'react', roomId: room.roomId, memberId: room.self.memberId, expectedEpoch: room.epoch, reaction: 'clap' });
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'room.reaction_limit', uncertain: null, busy: false });
});

test('capacity rejections explain a full deployment or a full room instead of a stale-state message', async () => {
  await connected(null);
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'room_capacity', replayed: false });
  await roomSession.run({ action: 'create', mediaTrackIds: ['1'.repeat(24)] });
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'room.capacity', uncertain: null, busy: false });
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'room_full', replayed: false });
  await roomSession.run({ action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 });
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'room.full', uncertain: null, busy: false });
  // Unknown and inherited-property codes keep the generic changed-state explanation.
  for (const code of ['playback_changed', '__proto__', 'constructor']) {
    mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code, replayed: false });
    await roomSession.run({ action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 });
    expect(roomSession.getSnapshot().error).toBe('social.stale');
  }
});

test('a full realtime pool shows its own message and waits for Retry-After before reconnecting or polling', async () => {
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Busy.', 'http', 503, 'realtime_capacity', 30));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, realtimeBusy: true, error: 'room.realtime_busy' });
  expect(Socket.instances).toHaveLength(0);
  const reads = mocks.getCurrentRoom.mock.calls.length;
  await vi.advanceTimersByTimeAsync(25_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(1);
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(reads);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
  expect(Socket.instances).toHaveLength(1);
  Socket.instances[0].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room: null });
  expect(roomSession.getSnapshot()).toMatchObject({ connected: true, realtimeBusy: false, error: null });
});

test('a room member refused a live connection keeps reading room state while its reconnect waits', async () => {
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Busy.', 'http', 503, 'realtime_capacity', 30));
  const room = pausedRoom(); mocks.getCurrentRoom.mockResolvedValue({ room });
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ room, realtimeBusy: true });
  const reads = mocks.getCurrentRoom.mock.calls.length;
  const updated = { ...room, revision: 2 }; mocks.getCurrentRoom.mockResolvedValue({ room: updated });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(reads + 5);
  expect(roomSession.getSnapshot().room).toEqual(updated);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(1);
});

test.each<RoomAction>([
  { action: 'create', mediaTrackIds: ['1'.repeat(24)] },
  { action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 }
])('a tab refused a live connection can still $action over HTTP and then connects at once', async action => {
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Busy.', 'http', 503, 'realtime_capacity', 30));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  const room = pausedRoom();
  mocks.getCurrentRoom.mockResolvedValue({ room });
  await roomSession.run(action);
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining(action));
  expect(roomSession.getSnapshot()).toMatchObject({ room, connected: false, busy: false });
  await vi.advanceTimersByTimeAsync(0);
  // The member's reserved seat is asked for immediately rather than after the Retry-After wait.
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
  Socket.instances[0].receive({ type: 'subscribed', protocolVersion: 1, serverTimeMs: 1_000_000, room });
  expect(roomSession.getSnapshot()).toMatchObject({ connected: true, realtimeBusy: false, error: null });
});

test('a tab refused a live connection keeps playback and other room commands waiting for one', async () => {
  mocks.getRealtimeTicket.mockRejectedValue(new ApiError('Busy.', 'http', 503, 'realtime_capacity', 30));
  const room = pausedRoom(); mocks.getCurrentRoom.mockResolvedValue({ room });
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ room, realtimeBusy: true });
  await roomSession.run({ action: 'react', roomId: room.roomId, memberId: room.self.memberId, expectedEpoch: room.epoch, reaction: 'heart' });
  await roomSession.run({ action: 'takeControl', roomId: room.roomId, memberId: room.self.memberId });
  await roomSession.control('play');
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  // A refused join keeps waiting for Retry-After instead of asking for a seat again.
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'room_full', replayed: false });
  await roomSession.run({ action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().error).toBe('room.full');
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(1);
});

test('without a capacity refusal, creating and joining still wait for a fresh live connection', async () => {
  mocks.getRealtimeTicket.mockRejectedValue(new ApiError('Unavailable.', 'network'));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, realtimeBusy: false, error: 'room.disconnected' });
  await roomSession.run({ action: 'create', mediaTrackIds: ['1'.repeat(24)] });
  await roomSession.run({ action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
});

test('a realtime backoff belongs to its session and never delays the next account', async () => {
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Busy.', 'http', 503, 'realtime_capacity', 300));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().error).toBe('room.realtime_busy');
  roomSession.stop();
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Unavailable.', 'network'));
  roomSession.ensure('viewer-2', vi.fn());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(3);
});

test('other ticket failures keep the ordinary disconnected message and five-second retry', async () => {
  // A rollout gate (rooms_disabled) stops reconnects instead; any other 503 is an ordinary connection loss.
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Unavailable.', 'http', 503, 'room_unavailable'));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot().error).toBe('room.disconnected');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
});

const member = { roomId: 'room-a', memberId: 'member-a' };
const queueControl = { ...member, controllerGeneration: 1, expectedEpoch: 1, expectedEntryId: 'entry-a',
  expectedPlaybackGeneration: 1, expectedControlGeneration: 1, expectedQueueRevision: 1 };
test.each<{ action: RoomAction['action']; command: RoomAction; code: string; message: string }>([
  { action: 'create', command: { action: 'create', mediaTrackIds: ['1'.repeat(24)] }, code: 'room_capacity', message: 'room.capacity' },
  { action: 'acceptInvitation', command: { action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 }, code: 'room_full', message: 'room.full' },
  { action: 'create', command: { action: 'create', mediaTrackIds: ['1'.repeat(24)] }, code: 'already_in_room', message: 'room.existing_room' },
  { action: 'acceptInvitation', command: { action: 'acceptInvitation', invitationId: 'invitation-a', generation: 1 }, code: 'invitation_unavailable', message: 'room.invitation_unavailable' },
  { action: 'invite', command: { ...member, action: 'invite', targetSocialId: `s_${'b'.repeat(32)}` }, code: 'room_invitation_capacity', message: 'room.invitation_limit' },
  { action: 'invite', command: { ...member, action: 'invite', targetSocialId: `s_${'b'.repeat(32)}` }, code: 'profile_unavailable', message: 'social.profile_unavailable' },
  { action: 'leave', command: { ...member, action: 'leave' }, code: 'host_exit_required', message: 'room.host_exit_required' },
  { action: 'react', command: { ...member, action: 'react', expectedEpoch: 1, reaction: 'heart' }, code: 'host_absent', message: 'room.suspended' },
  { action: 'requestSong', command: { ...member, action: 'requestSong', expectedEpoch: 1, mediaTrackId: '1'.repeat(24) }, code: 'room_request_capacity', message: 'room.request_capacity' },
  { action: 'acceptSongRequest', command: { ...queueControl, action: 'acceptSongRequest', requestId: 'request-a' }, code: 'room_queue_capacity', message: 'room.queue_full' },
  { action: 'removeQueueEntry', command: { ...queueControl, action: 'removeQueueEntry', targetEntryId: 'entry-b' }, code: 'room_forbidden', message: 'room.forbidden' }
])('$action refused with $code explains $message and retains no resend intent', async ({ command, code, message }) => {
  await connected(pausedRoom());
  mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code, replayed: false });
  await roomSession.run(command);
  expect(roomSession.getSnapshot()).toMatchObject({ error: message, uncertain: null, busy: false });
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
});

test('a rate-limited room command asks the listener to wait instead of offering outcome recovery', async () => {
  await connected(pausedRoom());
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Too many social actions.', 'http', 429, 'social_limit', 30));
  await roomSession.control('next');
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'social.rate_limited', uncertain: null, busy: false });
  await roomSession.control('next');
  // A fresh explicit gesture is still allowed; nothing was retained for an automatic resend.
  expect(mocks.prepareRoomCommand).toHaveBeenCalledTimes(2);
});

test('a recovered rejected outcome is explained for the original gesture and still refreshes every room surface', async () => {
  await connected(null);
  const refresh = vi.fn(); roomSession.ensure('viewer-1', refresh);
  mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Unknown', 'network'));
  await roomSession.run({ action: 'create', mediaTrackIds: ['1'.repeat(24)] });
  const original = roomSession.getSnapshot().uncertain!;
  expect(original.action).toBe('create');
  mocks.getSocialOutcome.mockResolvedValue({ outcome: { commandId: original.commandId, outcome: 'rejected', code: 'room_capacity', replayed: true } });
  await roomSession.checkOutcome();
  // The open-room limit, not "this room is full": the captured gesture was a creation.
  expect(roomSession.getSnapshot()).toMatchObject({ error: 'room.capacity', uncertain: null, busy: false });
  expect(refresh).toHaveBeenCalledExactlyOnceWith('rooms');
  expect(mocks.sendRoomCommand).toHaveBeenCalledTimes(1);
});

test.each(['rejected outcome', 'rate limit'])('an account switch while the %s copy loads leaves the replacement account clean', async kind => {
  await connected(pausedRoom());
  if (kind === 'rate limit') mocks.sendRoomCommand.mockRejectedValueOnce(new ApiError('Too many social actions.', 'http', 429, 'social_limit'));
  else mocks.sendRoomCommand.mockResolvedValueOnce({ commandId: 'immutable-command-123', outcome: 'rejected', code: 'room_reaction_limit', replayed: false });
  refusalHook.beforeExplain = () => { advanceAccountEpoch(); roomSession.ensure('viewer-2', vi.fn()); };
  const before = mocks.getCurrentRoom.mock.calls.length;
  await roomSession.run({ ...member, action: 'react', expectedEpoch: 1, reaction: 'heart' });
  expect(roomSession.getSnapshot()).toMatchObject({ viewerId: 'viewer-2', error: null, uncertain: null, busy: false });
  // Only the replacement account's own initial read ran; the old command never reconciled under it.
  expect(mocks.getCurrentRoom).toHaveBeenCalledTimes(before + 1);
});

test('ending a room retires membership before invalidating its active query observers', async () => {
  const room = pausedRoom(); await connected(room);
  const observed: (RoomSnapshot | null)[] = [];
  roomSession.ensure('viewer-1', () => observed.push(roomSession.getSnapshot().room));
  mocks.getCurrentRoom.mockResolvedValue({ room: null });
  await roomSession.run({ action: 'end', roomId: room.roomId, memberId: room.self.memberId });
  expect(observed).toEqual([null]);
});

test('a failed post-End reconciliation cannot invalidate the retained former room', async () => {
  const room = pausedRoom(); await connected(room);
  const invalidation = vi.fn(); roomSession.ensure('viewer-1', invalidation);
  mocks.getCurrentRoom.mockRejectedValueOnce(new ApiError('Read unavailable.', 'network'));
  await roomSession.run({ action: 'end', roomId: room.roomId, memberId: room.self.memberId });
  expect(invalidation).not.toHaveBeenCalled();
  expect(roomSession.getSnapshot()).toMatchObject({ uncertain: null, error: 'social.error', busy: false });
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

test('a ticket refused by a disabled rollout stops background reconnects until capabilities enable rooms again', async () => {
  mocks.getRealtimeTicket.mockRejectedValue(new ApiError('Disabled', 'http', 503, 'rooms_disabled'));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledOnce();
  // Unavailability is not presented as a connection the user could repair.
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, error: null });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledOnce(); expect(Socket.instances).toHaveLength(0);
  await roomSession.reconnect();
  expect(mocks.getRealtimeTicket).toHaveBeenCalledOnce();
  mocks.getRealtimeTicket.mockResolvedValue({ ticket: 'single-use-ticket', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2); expect(Socket.instances).toHaveLength(1);
});

test('an ordinary ticket failure still retries in the background', async () => {
  mocks.getRealtimeTicket.mockRejectedValueOnce(new ApiError('Unavailable', 'http', 503, 'room_unavailable'));
  roomSession.ensure('viewer-1', vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, error: 'room.disconnected' });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledTimes(2);
});

test('disabling rooms while connected is not reported as a lost connection', async () => {
  await connected();
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: false });
  expect(roomSession.getSnapshot()).toMatchObject({ connected: false, error: null, locallyPaused: true });
  expect(mocks.detach).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(16_000);
  expect(mocks.getRealtimeTicket).toHaveBeenCalledOnce();
});

test('a song request can be explicitly withdrawn without live transport while new requests remain blocked', async () => {
  roomSession.ensure('viewer-1', vi.fn(), { realtimeEnabled: false });
  await vi.advanceTimersByTimeAsync(0);
  await roomSession.run({ action: 'requestSong', roomId: 'room-a', memberId: 'member-a', expectedEpoch: 1, mediaTrackId: '1'.repeat(24) });
  expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  await roomSession.run({ action: 'dismissSongRequest', roomId: 'room-a', memberId: 'member-a', requestId: 'request-a' });
  expect(mocks.sendRoomCommand).toHaveBeenCalledExactlyOnceWith('viewer-1', expect.objectContaining({ action: 'dismissSongRequest', requestId: 'request-a' }));
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
  expect(roomSession.getSnapshot()).toMatchObject({ uncertain: null, error: 'room.unavailable' });
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

test('native media failure after real playback readiness withdraws readiness and recovers only through explicit resync', async () => {
  const audio = new RoomMedia();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  mocks.attach.mockImplementation((...args: Parameters<typeof store.attachRoomPlayback>) => store.attachRoomPlayback(...args));
  try {
    const room = pausedRoom(); room.timeline!.state = 'playing';
    room.members = room.members.map(member => ({ ...member, ready: true }));
    const socket = await connected(room); audio.ready();
    expect(socket.sent.filter(message => message.type === 'ready').at(-1)).toMatchObject({ report: { ready: true } });
    expect(audio.paused).toBe(false); expect(audio.playCalls).toBe(1);
    const pinnedSource = audio.src;
    socket.sent = []; audio.error = { code: 2 }; audio.emit('error');
    expect(socket.sent.filter(message => message.type === 'ready')).toEqual([
      expect.objectContaining({ report: expect.objectContaining({ ready: false, preparationId: 'current' }) })
    ]);
    expect(socket.sent.find(message => message.type === 'ping')).toMatchObject({ heartbeat: { locallyPaused: true } });
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: true, error: 'room.start_failed' });
    expect(audio.paused).toBe(true); expect(store.getSnapshot().error?.code).toBe('network');
    audio.emit('error');
    expect(socket.sent.filter(message => message.type === 'ready')).toHaveLength(1);
    const unready = { ...room, revision: 2, members: room.members.map(member => ({ ...member, ready: false })) };
    socket.receive({ type: 'snapshot', room: unready }); await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(audio.loadCalls).toBe(1); expect(audio.playCalls).toBe(1);
    socket.sent = []; await roomSession.resync();
    expect(audio.src).toBe(pinnedSource); expect(audio.loadCalls).toBe(2); expect(audio.paused).toBe(true);
    expect(socket.sent.some(message => message.type === 'ready' && message.report.ready)).toBe(false);
    audio.ready();
    expect(socket.sent.filter(message => message.type === 'ready').at(-1)).toMatchObject({ report: { ready: true } });
    expect(audio.playCalls).toBe(1);
    socket.receive({ type: 'snapshot', room: { ...unready, revision: 3,
      members: unready.members.map(member => ({ ...member, ready: true })) } });
    await vi.dynamicImportSettled();
    expect(audio.paused).toBe(false); expect(audio.playCalls).toBe(2); expect(audio.loadCalls).toBe(2);
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: false, error: null });
    expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  } finally { roomSession.stop(); store.destroy(); }
});

test.each(['exposed-error', 'rejected-install'] as const)('a real %s source install restores local failure without waiting for a native callback', async failure => {
  const audio = new RoomMedia();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  let rejectInstall = false;
  mocks.attach.mockImplementation((...args: Parameters<typeof store.attachRoomPlayback>) => store.attachRoomPlayback(...args));
  if (failure === 'rejected-install') mocks.attach.mockImplementation((...args: Parameters<typeof store.attachRoomPlayback>) =>
    store.attachRoomPlayback(args[0], (port, playbackOptions) => args[1]!({ ...port, install: async (queue, index) => {
      await port.install(queue, index);
      if (rejectInstall) { rejectInstall = false; throw new Error('Synthetic source installation failure.'); }
    } }, playbackOptions)));
  try {
    const room = pausedRoom(); room.timeline!.state = 'playing';
    room.members = room.members.map(member => ({ ...member, ready: true }));
    const socket = await connected(room); audio.ready();
    const pinnedSource = audio.src;
    roomSession.pauseLocally(); audio.error = { code: 2 };
    if (failure === 'exposed-error') vi.spyOn(audio, 'load').mockImplementationOnce(() => {
      audio.loadCalls++; audio.readyState = 0; audio.currentSrc = audio.src; audio.error = { code: 2 };
    });
    else rejectInstall = true;
    socket.sent = []; await roomSession.resync();
    expect(store.getSnapshot().error).toBeNull();
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: true, error: 'room.start_failed', connected: true });
    expect(socket.sent.filter(message => message.type === 'ready')).toEqual([
      expect.objectContaining({ report: expect.objectContaining({ ready: false }) })
    ]);
    expect(socket.sent.filter(message => message.type === 'ping').at(-1)).toMatchObject({ heartbeat: { locallyPaused: true } });
    expect(audio.paused).toBe(true); expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(1);
    if (failure === 'exposed-error') { audio.emit('error'); audio.emit('error'); }
    expect(socket.sent.filter(message => message.type === 'ready')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(audio.loadCalls).toBe(2);
    const unready = { ...room, revision: 2, members: room.members.map(member => ({ ...member, ready: false })) };
    socket.receive({ type: 'snapshot', room: unready }); await vi.dynamicImportSettled();
    await roomSession.resync();
    expect(audio.src).toBe(pinnedSource); expect(audio.loadCalls).toBe(3);
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: false, error: null });
    audio.ready();
    expect(socket.sent.filter(message => message.type === 'ready').at(-1)).toMatchObject({ report: { ready: true } });
    expect(audio.playCalls).toBe(1);
    socket.receive({ type: 'snapshot', room: { ...unready, revision: 3,
      members: unready.members.map(member => ({ ...member, ready: true })) } });
    await vi.dynamicImportSettled();
    expect(audio.playCalls).toBe(2); expect(audio.paused).toBe(false); expect(audio.loadCalls).toBe(3);
    expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  } finally { roomSession.stop(); store.destroy(); }
});

test('a real metadata retry timeout restores local failure state and leaves a later explicit retry reachable', async () => {
  const audio = new RoomMedia();
  const store = createPlayerStore({ audioFactory: () => audio, mediaSession: null });
  mocks.attach.mockImplementation((...args: Parameters<typeof store.attachRoomPlayback>) => store.attachRoomPlayback(...args));
  try {
    const room = pausedRoom(); room.timeline!.state = 'playing';
    room.members = room.members.map(member => ({ ...member, ready: true }));
    const socket = await connected(room);
    const pinnedSource = audio.src;
    await roomSession.resync();
    expect(audio.loadCalls).toBe(2); expect(store.getSnapshot().error).toBeNull();
    expect(roomSession.getSnapshot().locallyPaused).toBe(false);
    socket.sent = []; await vi.advanceTimersByTimeAsync(9999);
    expect(roomSession.getSnapshot().locallyPaused).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: true, error: 'room.start_failed', connected: true });
    expect(socket.sent.filter(message => message.type === 'ready')).toEqual([
      expect.objectContaining({ report: expect.objectContaining({ ready: false }) })
    ]);
    expect(socket.sent.filter(message => message.type === 'ping').at(-1)).toMatchObject({ heartbeat: { locallyPaused: true } });
    expect(audio.paused).toBe(true); expect(audio.loadCalls).toBe(2); expect(audio.playCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(audio.loadCalls).toBe(2);
    expect(socket.sent.filter(message => message.type === 'ready')).toHaveLength(1);
    const unready = { ...room, revision: 2, members: room.members.map(member => ({ ...member, ready: false })) };
    socket.receive({ type: 'snapshot', room: unready }); await vi.dynamicImportSettled();
    await roomSession.resync();
    expect(audio.src).toBe(pinnedSource); expect(audio.loadCalls).toBe(3);
    expect(roomSession.getSnapshot()).toMatchObject({ locallyPaused: false, error: null });
    audio.ready();
    expect(socket.sent.filter(message => message.type === 'ready').at(-1)).toMatchObject({ report: { ready: true } });
    expect(audio.playCalls).toBe(0);
    socket.receive({ type: 'snapshot', room: { ...unready, revision: 3,
      members: unready.members.map(member => ({ ...member, ready: true })) } });
    await vi.dynamicImportSettled();
    expect(audio.playCalls).toBe(1); expect(audio.paused).toBe(false); expect(audio.loadCalls).toBe(3);
    expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
  } finally { roomSession.stop(); store.destroy(); }
});

test.each(['entry', 'playback', 'account'] as const)('a stale %s media-failed observation cannot pause or withdraw current readiness', async stale => {
  const socket = await connected();
  const previousOptions = options;
  const observation = { type: 'media-failed' as const, entryId: 'entry-a', playbackEpoch: 1, positionSeconds: 0, monotonicMs: 0 };
  if (stale === 'entry') observation.entryId = 'former-entry';
  if (stale === 'playback') observation.playbackEpoch = 0;
  if (stale === 'account') advanceAccountEpoch();
  socket.sent = [];
  const before = roomSession.getSnapshot();
  previousOptions.onObservation?.(observation);
  expect(roomSession.getSnapshot()).toBe(before);
  expect(socket.sent).toEqual([]); expect(mocks.sendRoomCommand).not.toHaveBeenCalled();
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
