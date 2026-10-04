import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationalLogEntry } from '../src/infrastructure/operationalLog';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { createSocialOperations } from '../src/realtime/socialOperations';
import { createOperationalSummary } from '../src/services/operationalSummaryService';

const capacity = { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 10 };

const fixture = () => {
    const logged: OperationalLogEntry[] = [];
    const metrics = createRoomGatewayMetrics(() => 5_000, () => true);
    const operations = createSocialOperations({ log: () => undefined, metrics });
    let limiters: Record<string, number> = {};
    let media = 7;
    const summary = createOperationalSummary({ intervalMs: 60_000, capacity, metrics, operations, log: entry => { logged.push(entry); },
        takeLimiterRejections: () => { const taken = limiters; limiters = {}; return taken; }, mediaRejectedRequests: () => media });
    return { logged, metrics, operations, summary,
        setLimiters: (value: Record<string, number>) => { limiters = value; }, setMedia: (value: number) => { media = value; } };
};

test('the summary has a fixed numeric shape with interval deltas and totals for metric filters', () => {
    const { logged, metrics, operations, summary, setLimiters, setMedia } = fixture();
    metrics.setAuthorityState('ready');
    metrics.recordSuccessfulSweep();
    metrics.setOpenSockets(3);
    metrics.recordFailure('sweep', 2);
    operations.observeOpenRooms([`r_${'a'.repeat(32)}`]);
    operations.socketOpened(3);
    operations.recordUpgradeRejection('capacity');
    operations.recordCapacityRejection('sockets', 10);
    operations.recordTicketFailure('capacity');
    operations.recordRejection('realtime_capacity');
    operations.recordFanout(40);
    setLimiters({ 'room-http': 2, auth: 1 });
    setMedia(10);
    summary.flush();
    assert.equal(logged.length, 1);
    const entry = logged[0] as any;
    assert.equal(entry.category, 'ops_summary');
    assert.equal(entry.intervalMs, 60_000);
    assert.deepEqual(entry.capacity, capacity);
    assert.equal(entry.rooms.enabled, true);
    assert.equal(entry.rooms.authorityState, 'ready');
    assert.equal(entry.rooms.authorityChanges, 1);
    assert.equal(entry.rooms.lastSuccessfulSweepAgeMs, 0);
    assert.equal(entry.rooms.openRooms, 1);
    assert.equal(entry.rooms.openSockets, 3);
    assert.equal(entry.rooms.peakSockets, 3);
    assert.equal(entry.rooms.socketsOpened, 1);
    assert.equal(entry.rooms.upgradeRejectionsTotal, 1);
    assert.equal(entry.rooms.ticketFailuresTotal, 1);
    assert.equal(entry.rooms.capacityRejectionsTotal, 1);
    assert.deepEqual([entry.rooms.fanoutPasses, entry.rooms.fanoutLagMaxMs], [1, 40]);
    assert.deepEqual(entry.rooms.failures, { authorityAcquisition: 0, sweep: 2, refresh: 0, report: 0, disconnect: 0 });
    assert.equal(entry.rooms.failuresTotal, 2);
    assert.deepEqual(entry.rejections, { total: 1, byCode: { realtime_capacity: 1 } });
    assert.deepEqual(entry.limiters, { total: 6, byScope: { 'room-http': 2, auth: 1, 'media-delivery': 3 } });

    // The next interval reports only new failures and refusals, while gauges stay current.
    metrics.recordFailure('sweep');
    summary.flush();
    const next = logged[1] as any;
    assert.deepEqual(next.rooms.failures.sweep, 1);
    assert.equal(next.rooms.authorityChanges, 0);
    assert.equal(next.rooms.openSockets, 3);
    assert.equal(next.rooms.upgradeRejectionsTotal, 0);
    assert.deepEqual(next.limiters, { total: 0, byScope: {} });
    assert.deepEqual(next.rejections, { total: 0, byCode: {} });
});

test('the summary never carries identities and stays a small single line', () => {
    const { logged, operations, summary } = fixture();
    operations.roomTransition({ transition: 'created', roomId: `r_${'b'.repeat(32)}` });
    summary.flush();
    const line = JSON.stringify(logged[0]);
    assert.doesNotMatch(line, /r_b{32}|userId|sessionId|email|token|stack/);
    assert.ok(Buffer.byteLength(line) < 2_048);
});

test('the timer flushes each interval, survives a failing flush and stops cleanly', async () => {
    const logged: OperationalLogEntry[] = [];
    let fail = true;
    const summary = createOperationalSummary({ intervalMs: 5, capacity, metrics: createRoomGatewayMetrics(),
        operations: createSocialOperations({ log: () => undefined, metrics: createRoomGatewayMetrics() }),
        takeLimiterRejections: () => ({}), mediaRejectedRequests: () => 0,
        log: entry => { if (fail) { fail = false; throw new Error('Synthetic log failure.'); } logged.push(entry); } });
    const stop = summary.start();
    const deadline = Date.now() + 2_000;
    while (logged.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    stop();
    assert.ok(logged.length >= 2, 'A failed flush must not stop later summaries.');
    const count = logged.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(logged.length, count);
});
