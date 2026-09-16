import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomGatewayMetrics, roomGatewayFailureCategories } from '../src/realtime/roomGatewayMetrics';

test('room metrics expose fixed anonymous counters and a bounded successful-sweep age', () => {
    let now = 1_000;
    const metrics = createRoomGatewayMetrics(() => now, () => false);
    assert.deepEqual(metrics.snapshot(), {
        scope: 'process', enabled: false, authorityState: 'inactive', lastSuccessfulSweepAgeMs: null,
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
