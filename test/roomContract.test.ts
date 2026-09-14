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

test('song requests separate membership actions from immutable version-fenced queue moderation', () => {
    const member = { ...identity, roomId: 'r_room', memberId: 'm_member' };
    assert.ok(parseRoomCommand({ ...member, action: 'requestSong', expectedEpoch: 1, mediaTrackId: '1'.repeat(24) }));
    assert.ok(parseRoomCommand({ ...member, action: 'dismissSongRequest', requestId: 's_request' }));
    assert.equal(parseRoomCommand({ ...member, action: 'requestSong', mediaTrackId: '1'.repeat(24) }), null);
    assert.equal(parseRoomCommand({ ...member, action: 'acceptSongRequest', requestId: 's_request' }), null);
    const entries = ['e_first', 'e_second'];
    const parsed = parseRoomCommand({ ...control, action: 'reorderQueue', entryIds: entries });
    entries.reverse();
    assert.ok(parsed?.action === 'reorderQueue');
    assert.deepEqual(parsed.entryIds, ['e_first', 'e_second']);
    assert.ok(Object.isFrozen(parsed.entryIds));
    for (const entryIds of [[], ['e_first', 'e_first'], ['../private'], Array(101).fill('e_first')]) {
        assert.equal(parseRoomCommand({ ...control, action: 'reorderQueue', entryIds }), null);
    }
    assert.equal(parseRoomCommand({ ...control, action: 'removeQueueEntry', targetEntryId: 'e_second', requestedBy: 'spoof' }), null);
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

test('reactions are fixed member gestures with a captured epoch and no playback or arbitrary text fields', () => {
    const member = { ...identity, roomId: 'r_room', memberId: 'm_member', expectedEpoch: 1, action: 'react' };
    for (const reaction of ['heart', 'clap', 'fire', 'smile', 'music']) {
        const command = parseRoomCommand({ ...member, reaction });
        assert.deepEqual(command, { ...member, reaction });
        assert.ok(Object.isFrozen(command));
    }
    for (const reaction of ['❤️', 'chat text', '', null, { text: 'music' }]) {
        assert.equal(parseRoomCommand({ ...member, reaction }), null);
    }
    for (const delta of [{ expectedEpoch: 0 }, { expectedEpoch: '1' }, { actor: 'spoof' },
        { message: 'arbitrary text' }, { positionMs: 1000 }, { controllerGeneration: 1 }]) {
        assert.equal(parseRoomCommand({ ...member, reaction: 'heart', ...delta }), null);
    }
});
