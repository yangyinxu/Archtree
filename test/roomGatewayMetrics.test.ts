import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomGatewayMetrics, roomGatewayFailureCategories } from '../src/realtime/roomGatewayMetrics';

test('room metrics expose fixed anonymous counters and a bounded successful-sweep age', () => {
    let now = 1_000;
    const metrics = createRoomGatewayMetrics(() => now, () => false);
    assert.deepEqual(metrics.snapshot(), {
        scope: 'process', enabled: false, authorityState: 'inactive', authorityChanges: 0, lastSuccessfulSweepAgeMs: null,
        openSockets: 0, openRooms: null,
        failures: { authorityAcquisition: 0, sweep: 0, refresh: 0, report: 0, disconnect: 0 }
    });
    metrics.setAuthorityState('ready');
    metrics.recordSuccessfulSweep();
    now = 1_250.9;
    assert.equal(metrics.snapshot().lastSuccessfulSweepAgeMs, 250);
    metrics.recordFailure('sweep');
    metrics.setAuthorityState('unavailable');
    now = 2_000;
    assert.equal(metrics.snapshot().lastSuccessfulSweepAgeMs, 1_000);
    metrics.recordSuccessfulSweep();
    metrics.setAuthorityState('ready');
    assert.equal(metrics.snapshot().lastSuccessfulSweepAgeMs, 0);
    assert.equal(metrics.snapshot().failures.sweep, 1);
    now = 0;
    assert.equal(metrics.snapshot().lastSuccessfulSweepAgeMs, 0);
});

test('room metrics reject arbitrary labels and never retain identity or error data', () => {
    const metrics = createRoomGatewayMetrics();
    for (let index = 0; index < 10_000; index++) {
        metrics.recordFailure(`room-${index}-session-secret` as never);
        metrics.setAuthorityState(`user-${index}-error-secret` as never);
    }
    for (const category of roomGatewayFailureCategories) metrics.recordFailure(category);
    assert.deepEqual(Object.keys(metrics.snapshot().failures), [...roomGatewayFailureCategories]);
    assert.ok(Buffer.byteLength(JSON.stringify(metrics.snapshot())) < 256);
    assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /secret|userId|roomId|sessionId|error|stack|ticket|token/);
    metrics.recordFailure('__proto__' as never);
    metrics.recordFailure('constructor' as never);
    assert.equal(metrics.snapshot().authorityState, 'inactive');
    assert.equal(Object.keys(metrics.snapshot().failures).length, 5);
    assert.equal(metrics.snapshot().authorityChanges, 0, 'Rejected states are not changes.');
});

test('room counters saturate and snapshots and registries are independent', () => {
    const metrics = createRoomGatewayMetrics();
    metrics.recordFailure('report', Number.MAX_SAFE_INTEGER);
    metrics.recordFailure('report');
    metrics.recordFailure('disconnect', Infinity);
    metrics.recordFailure('disconnect', -1);
    metrics.recordFailure('disconnect', 0.5);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.failures.report, Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot.failures.disconnect, 0);
    snapshot.failures.report = 0;
    snapshot.authorityState = 'stopped';
    assert.equal(metrics.snapshot().failures.report, Number.MAX_SAFE_INTEGER);
    assert.equal(metrics.snapshot().authorityState, 'inactive');
    assert.equal(createRoomGatewayMetrics().snapshot().failures.report, 0);
});


test('rollout admission remains separate from an installed gateway authority state', () => {
    let enabled = false;
    const metrics = createRoomGatewayMetrics(Date.now, () => enabled);
    assert.equal(metrics.snapshot().authorityState, 'inactive');
    assert.equal(metrics.snapshot().enabled, false);
    enabled = true;
    metrics.setAuthorityState('starting');
    assert.equal(metrics.snapshot().enabled, true);
    metrics.setAuthorityState('ready');
    enabled = false;
    assert.equal(metrics.snapshot().enabled, false);
    assert.equal(metrics.snapshot().authorityState, 'ready');
});

test('a disabled wind-down reports its own authority state while rollout stays disabled', () => {
    const metrics = createRoomGatewayMetrics(Date.now, () => false);
    for (const state of ['starting', 'windingDown', 'unavailable', 'inactive'] as const) {
        metrics.setAuthorityState(state);
        assert.deepEqual([metrics.snapshot().enabled, metrics.snapshot().authorityState], [false, state]);
    }
});

test('each authority state change writes one line and counts, while renewals of the same state stay silent', () => {
    const logged: unknown[] = [];
    const metrics = createRoomGatewayMetrics(Date.now, () => true, entry => { logged.push(entry); });
    for (const state of ['starting', 'ready', 'ready', 'ready', 'unavailable', 'ready', 'stopped'] as const) metrics.setAuthorityState(state);
    metrics.setAuthorityState('private-state' as never);
    assert.deepEqual(logged, ['starting', 'ready', 'unavailable', 'ready', 'stopped'].map(state => ({ category: 'room_authority', state })));
    assert.equal(metrics.snapshot().authorityChanges, 5);
});

test('socket and open-room gauges accept only non-negative whole numbers', () => {
    const metrics = createRoomGatewayMetrics();
    metrics.setOpenSockets(3); metrics.setOpenRooms(1);
    for (const value of [-1, 1.5, Number.NaN, Infinity]) { metrics.setOpenSockets(value); metrics.setOpenRooms(value); }
    assert.deepEqual([metrics.snapshot().openSockets, metrics.snapshot().openRooms, metrics.openSockets()], [3, 1, 3]);
    metrics.setOpenSockets(0); metrics.setOpenRooms(0);
    assert.deepEqual([metrics.snapshot().openSockets, metrics.snapshot().openRooms], [0, 0]);
});
