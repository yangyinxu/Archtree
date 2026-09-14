import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoomCommand, parseRoomHeartbeat, parseRoomReady } from '../src/contracts/roomV1';

const identity = { scopeToken: 'synthetic-scope-for-room-contract', commandId: 'synthetic-command-0001' };
const control = { ...identity, roomId: 'r_example', memberId: 'm_example', expectedEpoch: 1,
    controllerGeneration: 1, expectedControlGeneration: 2, expectedPlaybackGeneration: 3,
    expectedQueueRevision: 1, expectedEntryId: 'e_first' };

test('room commands freeze the original queue and transport expectations before asynchronous work', () => {
    const ids = ['1'.repeat(24), '2'.repeat(24)];
    const create = parseRoomCommand({ ...identity, action: 'create', mediaTrackIds: ids });
    assert.ok(create && create.action === 'create');
    ids[0] = '3'.repeat(24);
    assert.equal(create.mediaTrackIds[0], '1'.repeat(24));
    assert.ok(Object.isFrozen(create.mediaTrackIds));
    const input = { ...control, action: 'next' };
    const parsed = parseRoomCommand(input);
    input.expectedPlaybackGeneration++;
    assert.ok(parsed && 'expectedPlaybackGeneration' in parsed);
    assert.equal(parsed.expectedPlaybackGeneration, 3);
    assert.ok(Object.isFrozen(parsed));
});

test('room command parsing rejects identity injection, fractional versions, unknown actions and unbounded queues', () => {
    for (const input of [
        { ...control, action: 'next', userId: 'private' }, { ...control, action: 'next', expectedPlaybackGeneration: 1.5 },
        { ...control, action: 'setControlMode', mode: 'admin' }, { ...control, action: 'seek', positionMs: -1 },
        { ...identity, action: 'create', mediaTrackIds: [] },
        { ...identity, action: 'create', mediaTrackIds: Array(101).fill('1'.repeat(24)) },
        { ...identity, action: 'create', mediaTrackIds: ['https://untrusted.invalid/stream'] },
        { ...control, action: 'naturalEnd' }, { ...identity, action: 'acceptInvitation', invitationId: 'i_id', generation: 0 }
    ]) assert.equal(parseRoomCommand(input), null);
});

test('deny-only member actions bind the membership incarnation without stale playback expectations', () => {
    assert.ok(parseRoomCommand({ ...identity, action: 'leave', roomId: 'r_room', memberId: 'm_old' }));
    assert.equal(parseRoomCommand({ ...identity, action: 'leave', roomId: 'r_room' }), null);
});

test('readiness reports require exact media/preparation and controller generations, while heartbeat has no playback command', () => {
    const report = { roomId: 'r_room', memberId: 'm_member', controllerGeneration: 1, expectedEpoch: 1,
        preparationId: 'p_first', playbackGeneration: 4, entryId: 'e_entry', mediaRevision: 'mr_media', sequence: 1, ready: true };
    assert.ok(parseRoomReady(report));
    assert.equal(parseRoomReady({ ...report, sequence: 0 }), null);
    assert.equal(parseRoomReady({ ...report, action: 'next' }), null);
    assert.ok(parseRoomHeartbeat({ roomId: 'r_room', memberId: 'm_member', controllerGeneration: 1, locallyPaused: true }));
    assert.equal(parseRoomHeartbeat({ roomId: 'r_room', memberId: 'm_member', controllerGeneration: 1, locallyPaused: 'false' }), null);
});
