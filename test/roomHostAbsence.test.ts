import assert from 'node:assert/strict';
import test from 'node:test';
import { roomHostPlaybackSuspended, roomMemberConnected } from '../src/application/rooms/roomHostAbsence';
import { ROOM_LIMITS } from '../src/contracts/roomV1';
import type { RoomDocument, RoomMemberDocument } from '../src/repositories/social/roomDocuments';

const heartbeatAt = 1_000_000;
const grace = ROOM_LIMITS.hostGraceMs;
const member = (membershipId: string, values: Partial<RoomMemberDocument> = {}): RoomMemberDocument => ({ membershipId,
    accountId: membershipId.padEnd(24, '0'), socialId: `s_${membershipId}`, controllerSessionId: 'synthetic-session',
    controllerClientId: 'synthetic-client', controllerGeneration: 1, joinedAt: new Date(heartbeatAt), lastSeenAt: new Date(heartbeatAt),
    locallyPaused: false, connectionPresent: true, ...values });
/** Only the fields the predicate reads; everything else about a room is irrelevant to host absence. */
const room = (host: Partial<RoomMemberDocument> = {}, values: Partial<Pick<RoomDocument, 'hostAbsentSince' | 'hostSuspended' | 'hostMembershipId'>> = {}) => ({
    members: [member('host', host), member('guest')], hostMembershipId: 'host', hostAbsentSince: null, hostSuspended: false, ...values });

test('a controller is connected only while attached and inside the heartbeat grace', () => {
    assert.equal(roomMemberConnected(member('a'), heartbeatAt + grace - 1), true);
    assert.equal(roomMemberConnected(member('a'), heartbeatAt + grace), false);
    assert.equal(roomMemberConnected(member('a', { connectionPresent: false }), heartbeatAt), false);
});

test('a present host never holds playback, and an explicit disconnect keeps the room live for the whole grace', () => {
    assert.equal(roomHostPlaybackSuspended(room(), heartbeatAt + 5_000), false);
    const disconnected = room({ connectionPresent: false }, { hostAbsentSince: new Date(heartbeatAt) });
    assert.equal(roomHostPlaybackSuspended(disconnected, heartbeatAt), false);
    assert.equal(roomHostPlaybackSuspended(disconnected, heartbeatAt + grace - 1), false);
    assert.equal(roomHostPlaybackSuspended(disconnected, heartbeatAt + grace), true);
});

test('an absence a sweep has not recorded is measured from the last heartbeat, never restarted by noticing it late', () => {
    // A silent drop leaves the socket marked present; once the heartbeat is stale the grace is already over.
    assert.equal(roomHostPlaybackSuspended(room(), heartbeatAt + grace), true);
    assert.equal(roomHostPlaybackSuspended(room({ connectionPresent: false }), heartbeatAt + grace - 1), false);
    assert.equal(roomHostPlaybackSuspended(room({ connectionPresent: false }), heartbeatAt + grace), true);
    // A recorded start wins over a later heartbeat timestamp, for example a host takeover that has not connected yet.
    const takeover = room({ connectionPresent: false, lastSeenAt: new Date(heartbeatAt + grace) }, { hostAbsentSince: new Date(heartbeatAt) });
    assert.equal(roomHostPlaybackSuspended(takeover, heartbeatAt + grace), true);
});

test('a recorded suspension outlives the host return and a missing host always holds playback', () => {
    assert.equal(roomHostPlaybackSuspended(room({}, { hostSuspended: true }), heartbeatAt), true);
    assert.equal(roomHostPlaybackSuspended(room({}, { hostMembershipId: 'departed' }), heartbeatAt), true);
});
