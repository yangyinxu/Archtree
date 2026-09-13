import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    parseRoomPlaybackPrototypeCommand,
    parseRoomPlaybackPrototypeSnapshot,
    roomPlaybackTargetMs,
    type RoomPlaybackPrototypeCommand,
    type RoomPlaybackPrototypeSnapshot
} from '../src/contracts/roomPlaybackPrototype';
import {
    RoomPlaybackPrototypeAuthority,
    transitionPrototypeRoom,
    type PrototypeRoomState
} from '../src/application/rooms/roomPlaybackPrototype';

const fixture = JSON.parse(readFileSync(new URL('../contracts/social/prototype-v1/playback-trace.json', import.meta.url), 'utf8'));
const first = (): RoomPlaybackPrototypeSnapshot => ({ ...fixture.snapshots[0].snapshot });
const host = { memberId: 'member-a', controllerGeneration: 1 };
const guest = { memberId: 'member-b', controllerGeneration: 1 };
const initial = (): PrototypeRoomState => ({
    snapshot: first(), hostMemberId: host.memberId, hostPresent: true,
    controlMode: 'everyone', participants: [host, guest],
    queue: ['a', 'b', 'c'].map((letter, index) => ({
        entryId: `entry-${letter}`, mediaTrackId: `${index + 1}`.padStart(24, '0'),
        mediaRevision: `synthetic-revision-${letter}`, mediaType: 'audio', durationMs: 2000
    }))
});
const envelope = (commandId: string, snapshot = first()) => ({
    commandId, expectedEpoch: snapshot.epoch, expectedControlGeneration: snapshot.controlGeneration,
    expectedPlaybackGeneration: snapshot.playbackGeneration, expectedQueueRevision: snapshot.queueRevision,
    expectedEntryId: snapshot.entryId
});
const next = (id: string, snapshot = first()): RoomPlaybackPrototypeCommand => ({ ...envelope(id, snapshot), action: 'next' });

test('shared trace is bounded, complete, synthetic, and contains duplicate/stale/correction cases', () => {
    assert.equal(fixture.fixtureVersion, 1);
    assert.equal(fixture.snapshots.length, 7);
    for (const frame of fixture.snapshots) assert.ok(parseRoomPlaybackPrototypeSnapshot(frame.snapshot), frame.name);
    assert.equal(fixture.snapshots[2].expectedDisposition, 'ignored');
    assert.equal(fixture.snapshots[4].expectedDisposition, 'ignored');
});

test('two distinct simultaneous Next intents consume the old occurrence once in either order', async () => {
    for (const order of [[host, guest], [guest, host]]) {
        const authority = new RoomPlaybackPrototypeAuthority(initial(), 20_000);
        const commands = [next('first'), next('second')];
        const results = await Promise.all(order.map((actor, index) => Promise.resolve().then(() => authority.submit(actor, commands[index], 10_000))));
        assert.equal(results.filter(result => result.status === 'accepted').length, 1);
        assert.equal(results.filter(result => result.reason === 'stale_playback').length, 1);
        assert.equal(authority.inspect().snapshot.entryId, 'entry-b');
        assert.equal(authority.inspect().snapshot.playbackGeneration, 42);
        assert.equal(authority.inspect().snapshot.state, 'preparing');
        const staleRetry = authority.submit(order[1], commands[1], 10_001);
        assert.equal(staleRetry.reason, 'stale_playback');
        assert.equal(authority.inspect().snapshot.entryId, 'entry-b');
    }
});

test('competing different selections keep the first committed choice, while a later fresh intent is valid', () => {
    for (const targets of [['entry-b', 'entry-c'], ['entry-c', 'entry-b']]) {
        const authority = new RoomPlaybackPrototypeAuthority(initial(), 20_000);
        assert.equal(authority.submit(host, { ...envelope('select-one'), action: 'select', targetEntryId: targets[0] }, 10_000).status, 'accepted');
        assert.equal(authority.submit(guest, { ...envelope('select-two'), action: 'select', targetEntryId: targets[1] }, 10_000).reason, 'stale_playback');
        assert.equal(authority.inspect().snapshot.entryId, targets[0]);
        const current = authority.inspect().snapshot;
        assert.equal(authority.submit(guest, { ...envelope('fresh-selection', current), action: 'select', targetEntryId: targets[1] }, 10_001).status, 'accepted');
        assert.equal(authority.inspect().snapshot.entryId, targets[1]);
    }
});

test('same-intent replay never executes twice or leaks an old snapshot', () => {
    const authority = new RoomPlaybackPrototypeAuthority(initial(), 20_000);
    const command = next('same-command');
    assert.equal(authority.submit(host, command, 10_000).status, 'accepted');
    const duplicate = authority.submit(host, command, 10_001);
    assert.deepEqual(duplicate, { status: 'duplicate' });
    assert.equal(authority.inspect().snapshot.playbackGeneration, 42);
    assert.equal(authority.submit(host, { ...command, action: 'pause' }, 10_001).reason, 'idempotency_conflict');
    assert.equal(authority.submit(host, command, 20_000).reason, 'scope_expired');
});

test('driver-style callback retry preserves the frozen precondition instead of rebasing Next', () => {
    const original = next('frozen');
    const immutable = parseRoomPlaybackPrototypeCommand(original)!;
    const winner = transitionPrototypeRoom(initial(), host, next('winner'), 10_000);
    assert.equal(winner.status, 'accepted');
    const retry = transitionPrototypeRoom(winner.state, guest, immutable, 10_001);
    assert.equal(retry.status, 'rejected');
    assert.equal(retry.status === 'rejected' && retry.reason, 'stale_playback');
    assert.equal(immutable.expectedPlaybackGeneration, 41);
    assert.ok(Object.isFrozen(immutable));
    assert.equal(original.expectedEntryId, 'entry-a');
});

test('host-only control, inactive observers and stale controllers cannot mutate playback', () => {
    const room = { ...initial(), controlMode: 'hostOnly' as const };
    const guestResult = transitionPrototypeRoom(room, guest, next('guest'), 10_000);
    assert.equal(guestResult.status === 'rejected' && guestResult.reason, 'forbidden');
    const observer = transitionPrototypeRoom(room, { ...host, controllerGeneration: 0 }, next('observer'), 10_000);
    assert.equal(observer.status === 'rejected' && observer.reason, 'stale_controller');
    assert.equal(transitionPrototypeRoom(room, host, next('host'), 10_000).status, 'accepted');
});

test('mode changes are host-only, keep the timeline, and fence stale commands after a mode round trip', () => {
    const authority = new RoomPlaybackPrototypeAuthority(initial(), 20_000);
    const setMode = { ...envelope('mode-one'), action: 'setControlMode' as const, mode: 'hostOnly' as const };
    assert.equal(authority.submit(guest, setMode, 10_000).reason, 'forbidden');
    assert.equal(authority.submit(host, setMode, 10_000).status, 'accepted');
    assert.equal(authority.inspect().snapshot.playbackGeneration, 41);
    assert.equal(authority.inspect().snapshot.controlGeneration, 2);
    assert.equal(authority.submit(guest, next('stale-guest'), 10_000).reason, 'stale_permission');
    const restore = { ...envelope('mode-two', authority.inspect().snapshot), action: 'setControlMode', mode: 'everyone' };
    assert.equal(authority.submit(host, restore, 10_000).status, 'accepted');
    assert.equal(authority.inspect().snapshot.controlGeneration, 3);
    assert.equal(authority.submit(guest, next('ancient-command'), 10_000).reason, 'stale_permission');
});

test('mode versus Next has a definite order without undoing a previously accepted transition', () => {
    const authority = new RoomPlaybackPrototypeAuthority(initial(), 20_000);
    assert.equal(authority.submit(guest, next('before-mode'), 10_000).status, 'accepted');
    assert.equal(authority.submit(host, { ...envelope('mode-after'), action: 'setControlMode', mode: 'hostOnly' }, 10_001).status, 'accepted');
    assert.equal(authority.inspect().snapshot.entryId, 'entry-b');
    assert.equal(authority.inspect().snapshot.state, 'preparing');
});

test('queue reorder, old room epoch, host absence, and invalid seeks fail without side effects', () => {
    const room = initial();
    const reordered = { ...room, snapshot: { ...room.snapshot, queueRevision: 2 } };
    const result = transitionPrototypeRoom(reordered, host, next('order'), 10_000);
    assert.equal(result.status === 'rejected' && result.reason, 'stale_queue');
    for (const [state, command, reason] of [
        [{ ...room, hostPresent: false }, next('absence'), 'host_absent'],
        [{ ...room, snapshot: { ...room.snapshot, epoch: 2 } }, next('epoch'), 'stale_epoch'],
        [room, { ...envelope('seek'), action: 'seek', positionMs: 2001 }, 'position_out_of_range']
    ] as const) {
        const rejected = transitionPrototypeRoom(state, host, command, 10_000);
        assert.equal(rejected.status === 'rejected' && rejected.reason, reason);
        assert.deepEqual(rejected.state, state);
    }
    assert.equal(room.snapshot.entryId, 'entry-a');
});

test('pause anchors the extrapolated position and timestamps cannot move paused clocks', () => {
    const room = initial();
    room.snapshot = { ...room.snapshot, state: 'playing' };
    const paused = transitionPrototypeRoom(room, guest, { ...envelope('pause'), action: 'pause' }, 10_450);
    assert.equal(paused.status, 'accepted');
    assert.equal(paused.state.snapshot.positionMs, 450);
    assert.equal(roomPlaybackTargetMs(paused.state.snapshot, 99_000), 450);
    assert.equal(roomPlaybackTargetMs({ ...first(), state: 'playing' }, 9_000), 0);
    assert.equal(roomPlaybackTargetMs({ ...first(), state: 'playing' }, 99_000), 2000);
});

test('untrusted commands and snapshots reject extras, invalid bounds and unsupported types', () => {
    for (const invalid of [
        null, [], { ...next('extra'), userId: 'spoof' }, { ...next('nan'), expectedEpoch: NaN },
        { ...next('float'), expectedPlaybackGeneration: 1.5 }, { ...next('long'), commandId: 'x'.repeat(81) },
        { ...next('unknown'), action: 'broadcastWhatever' }, { ...next('seek'), action: 'seek', positionMs: -1 }
    ]) assert.equal(parseRoomPlaybackPrototypeCommand(invalid), null);
    for (const invalid of [
        { ...first(), protocolVersion: 2 }, { ...first(), durationMs: 0 }, { ...first(), positionMs: 2001 },
        { ...first(), mediaType: 'live' }, { ...first(), ownerEmail: 'not-allowed' }, { ...first(), revision: Infinity }
    ]) assert.equal(parseRoomPlaybackPrototypeSnapshot(invalid), null);
});

test('prototype state and replies cannot be modified through previously returned copies', () => {
    const room = initial();
    const authority = new RoomPlaybackPrototypeAuthority(room, 20_000);
    room.queue[0].mediaRevision = 'changed-outside';
    const copy = authority.inspect();
    copy.snapshot.entryId = 'entry-c';
    assert.equal(authority.inspect().snapshot.entryId, 'entry-a');
    assert.equal(authority.inspect().queue[0].mediaRevision, 'synthetic-revision-a');
});

test('queue entries require complete media identity and cannot replace room authority fields', () => {
    for (const invalidEntry of [
        { entryId: 'entry-b', mediaTrackId: '000000000000000000000002' },
        { ...initial().queue[1], roomId: 'different-room', epoch: 2 }
    ]) {
        const room = initial();
        room.queue = [room.queue[0], invalidEntry as PrototypeRoomState['queue'][number], room.queue[2]];
        assert.throws(() => new RoomPlaybackPrototypeAuthority(room, 20_000), /Invalid synthetic room/);
        const result = transitionPrototypeRoom(room, host, next('invalid-queue'), 10_000);
        assert.equal(result.status === 'rejected' && result.reason, 'invalid_command');
        assert.equal(result.state.snapshot.roomId, 'synthetic-room');
        assert.equal(result.state.snapshot.epoch, 1);
        assert.equal(result.state.snapshot.entryId, 'entry-a');
    }
});

test('version overflow and next-at-end never create an invalid generation or wrap the queue', () => {
    const room = initial();
    room.snapshot.revision = Number.MAX_SAFE_INTEGER;
    const result = transitionPrototypeRoom(room, host, next('overflow'), 10_000);
    assert.equal(result.status === 'rejected' && result.reason, 'version_exhausted');
    const end = initial();
    end.snapshot = { ...end.snapshot, ...end.queue[2] };
    const terminal = transitionPrototypeRoom(end, host, next('end', end.snapshot), 10_000);
    assert.equal(terminal.status, 'noop');
    assert.equal(terminal.state.snapshot.entryId, 'entry-c');
});
