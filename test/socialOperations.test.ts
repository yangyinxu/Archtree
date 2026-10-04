import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationalLogEntry } from '../src/infrastructure/operationalLog';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { createSocialOperations } from '../src/realtime/socialOperations';

const fixture = (start = 1_000) => {
    let now = start;
    const logged: OperationalLogEntry[] = [];
    const metrics = createRoomGatewayMetrics(() => now, () => true);
    const operations = createSocialOperations({ now: () => now, log: entry => { logged.push(entry); }, metrics });
    return { operations, metrics, logged, advance: (milliseconds: number) => { now += milliseconds; } };
};
const roomA = `r_${'a'.repeat(32)}`;
const roomB = `r_${'b'.repeat(32)}`;
const roomC = `r_${'c'.repeat(32)}`;

test('socket, upgrade, ticket and fanout counts cover one interval and reset when taken', () => {
    const { operations, metrics } = fixture();
    metrics.setOpenSockets(2);
    operations.socketOpened(1); operations.socketOpened(2);
    for (const code of [1000, 1001, 1008, 1013, 1006, 4000]) operations.socketClosed(code);
    operations.recordUpgradeRejection('capacity'); operations.recordUpgradeRejection('perAccount');
    operations.recordUpgradeRejection('private-label' as never);
    operations.recordTicketFailure('limit'); operations.recordTicketFailure('session');
    operations.recordFanout(12.4); operations.recordFanout(250.6); operations.recordFanout(Number.NaN); operations.recordFanout(-3);
    const taken = operations.take();
    assert.equal(taken.socketsOpened, 2);
    assert.equal(taken.socketsClosed, 6);
    assert.equal(taken.peakSockets, 2);
    assert.deepEqual(taken.socketCloses, { normal: 1, goingAway: 1, policy: 1, unavailable: 1, abnormal: 2 });
    assert.deepEqual(taken.upgradeRejections, { unavailable: 0, unauthorized: 0, attemptRate: 0, pending: 0, capacity: 1, perAddress: 0, perAccount: 1 });
    assert.deepEqual(taken.ticketFailures, { capacity: 0, perAccount: 0, limit: 1, session: 1, unavailable: 0 });
    assert.deepEqual([taken.fanoutPasses, taken.fanoutLagMaxMs], [4, 251]);

    const next = operations.take();
    assert.deepEqual([next.socketsOpened, next.socketsClosed, next.fanoutPasses, next.fanoutLagMaxMs], [0, 0, 0, 0]);
    assert.equal(next.peakSockets, 2, 'A new interval starts from the sockets still open.');
});

test('capacity refusals are all counted but write one line per limit each minute', () => {
    const { operations, logged, advance } = fixture();
    for (let index = 0; index < 50; index += 1) operations.recordCapacityRejection('sockets', 10);
    operations.recordCapacityRejection('openRooms', 1);
    advance(59_999); operations.recordCapacityRejection('sockets', 10);
    advance(1); operations.recordCapacityRejection('sockets', 10);
    operations.recordCapacityRejection('everything' as never, 1);
    assert.deepEqual(logged, [
        { category: 'social_capacity', limit: 'sockets', maximum: 10 },
        { category: 'social_capacity', limit: 'openRooms', maximum: 1 },
        { category: 'social_capacity', limit: 'sockets', maximum: 10 }]);
    assert.deepEqual(operations.take().capacityRejections, { sockets: 52, openRooms: 1, roomMembers: 0 });
});

test('rejection codes accept only code-shaped constants and stay bounded', () => {
    const { operations } = fixture();
    operations.recordRejection('social_limit'); operations.recordRejection('social_limit'); operations.recordRejection('room_full');
    for (const value of ['', 'Room_Full', 'user@example.test', 'a'.repeat(49), 'code with spaces', '../path']) operations.recordRejection(value);
    for (let index = 0; index < 100; index += 1) operations.recordRejection(`synthetic_code_${'x'.repeat(index % 40)}`);
    const { rejections } = operations.take();
    assert.equal(rejections.social_limit, 2);
    assert.equal(rejections.room_full, 1);
    assert.ok(Object.keys(rejections).length <= 32);
    assert.doesNotMatch(JSON.stringify(rejections), /@|\s|\.\./);
    assert.deepEqual(operations.take().rejections, {});
});

test('room transitions log fixed shapes with only an opaque room ID and reject invalid input', () => {
    const { operations, logged } = fixture();
    operations.roomTransition({ transition: 'created', roomId: roomA });
    operations.roomTransition({ transition: 'suspended', roomId: roomA });
    operations.roomTransition({ transition: 'closed', reason: 'hostAbsent', roomId: roomA });
    operations.roomTransition({ transition: 'closed', reason: 'private reason' as never, roomId: roomB });
    operations.roomTransition({ transition: 'created', roomId: 'room id with spaces' });
    operations.roomTransition({ transition: 'renamed' as never, roomId: roomB });
    assert.deepEqual(logged, [
        { category: 'room_lifecycle', transition: 'created', roomId: roomA },
        { category: 'room_lifecycle', transition: 'suspended', roomId: roomA },
        { category: 'room_lifecycle', transition: 'closed', reason: 'hostAbsent', roomId: roomA }]);
    const taken = operations.take();
    assert.deepEqual([taken.roomsCreated, taken.roomsSuspended, taken.roomsClosed], [1, 1, 1]);
});

test('the sweep reports a room that vanished without a closure one sweep later, never a reported one', () => {
    const { operations, logged, metrics } = fixture();
    operations.observeOpenRooms([roomA, roomB, roomC]);
    assert.equal(metrics.snapshot().openRooms, 3);
    // B ended by its host (reported before the sweep); C ended by its host but reported after the sweep saw it vanish.
    operations.roomTransition({ transition: 'closed', reason: 'hostEnded', roomId: roomB });
    operations.observeOpenRooms([roomA]);
    operations.roomTransition({ transition: 'closed', reason: 'hostEnded', roomId: roomC });
    assert.equal(metrics.snapshot().openRooms, 1);
    // A closes through an account change that reports nothing.
    operations.observeOpenRooms([]);
    assert.equal(logged.filter(entry => entry.reason === 'accountLifecycle').length, 0);
    operations.observeOpenRooms([]);
    operations.observeOpenRooms([]);
    assert.deepEqual(logged.map(entry => [entry.roomId, entry.reason]),
        [[roomB, 'hostEnded'], [roomC, 'hostEnded'], [roomA, 'accountLifecycle']]);
    assert.equal(operations.take().roomsClosed, 3);
    assert.equal(metrics.snapshot().openRooms, 0);
});

test('a process start observes open rooms without reporting them, and the reported-closure memory stays bounded', () => {
    const { operations, logged } = fixture();
    for (let index = 0; index < 600; index += 1) {
        operations.roomTransition({ transition: 'closed', reason: 'expired', roomId: `r_${index.toString(16).padStart(32, '0')}` });
    }
    logged.length = 0;
    operations.observeOpenRooms([roomA]);
    operations.observeOpenRooms([roomA]);
    assert.deepEqual(logged, []);
});
