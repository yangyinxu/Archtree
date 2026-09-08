import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { Db } from 'mongodb';
import { setTimeout as delay } from 'node:timers/promises';

import { createHealthController } from '../src/controllers/healthController';
import { createMediaDeliveryMetricsRegistry } from '../src/services/mediaDeliveryService';

const responseDouble = () => {
    const headers = new Map<string, string>();
    const state: { statusCode: number; body?: any } = { statusCode: 200 };
    const response = {
        setHeader(name: string, value: string | number) {
            headers.set(name.toLowerCase(), String(value));
            return response;
        },
        status(statusCode: number) {
            state.statusCode = statusCode;
            return response;
        },
        json(body: unknown) {
            state.body = body;
            return response;
        }
    } as unknown as Response;
    return { response, headers, state };
};

// Like the real database cache, a connection keeps a stable identity until replaced.
const stableDatabase = (db: Pick<Db, 'command'>) => () => db;

const memoryUsage = () => ({
    rss: 123_456,
    heapTotal: 100_000,
    heapUsed: 45_678,
    external: 0,
    arrayBuffers: 0
});

test('health exposes a no-store anonymous media snapshot when MongoDB is ready', async () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    metrics.setAdmissionLimits({
        global: 40,
        perIp: 8,
        playbackReservedGlobal: 16,
        playbackReservedPerIp: 2
    });
    metrics.markRequestAccepted('playback');
    metrics.markRequestFinished('playback', 'success');
    let pingCommand: unknown;
    let pingOptions: unknown;
    const handler = createHealthController({
        checkIndexes: async () => true,
        getDatabase: stableDatabase({
            command: async (command, options) => {
                pingCommand = command;
                pingOptions = options;
                return { ok: 1 };
            }
        }),
        getMetrics: () => metrics.snapshot(),
        getMemoryUsage: memoryUsage,
        getUptimeSeconds: () => 12.9
    });
    const { response, headers, state } = responseDouble();

    await handler({} as Request, response);

    assert.equal(state.statusCode, 200);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.deepEqual(pingCommand, { ping: 1 });
    assert.deepEqual(pingOptions, { maxTimeMS: 1_000 });
    assert.equal(state.body.status, 'ok');
    assert.equal(state.body.uptimeSeconds, 12);
    assert.deepEqual(state.body.memory, {
        rssBytes: 123_456,
        heapUsedBytes: 45_678
    });
    assert.equal(state.body.mediaDelivery.byResource.playback.acceptedRequests, 1);
    const serialized = JSON.stringify(state.body);
    for (const forbidden of ['userId', 'sessionId', 's3Key', 'mediaId', 'ipAddress']) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test('health preserves media diagnostics but returns 503 when MongoDB is unavailable', async () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    metrics.markRequestRejected('artwork', 'playbackReserved');
    const handler = createHealthController({
        checkIndexes: async () => true,
        getDatabase: () => null,
        getMetrics: () => metrics.snapshot(),
        getMemoryUsage: memoryUsage,
        getUptimeSeconds: () => 4
    });
    const { response, headers, state } = responseDouble();

    await handler({} as Request, response);

    assert.equal(state.statusCode, 503);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(state.body.status, 'unavailable');
    assert.equal(state.body.mediaDelivery.byResource.artwork.rejectedRequests, 1);
    assert.equal(state.body.memory, undefined);
});

test('database ping cannot make missing constraints or a draining process ready', async () => {
    for (const draining of [false, true]) {
        let pinged = false;
        const handler = createHealthController({
            isDraining: () => draining,
            checkIndexes: async () => false,
            getDatabase: stableDatabase({ command: async () => { pinged = true; return { ok: 1 }; } })
        });
        const { response, state } = responseDouble();
        await handler({} as Request, response);
        assert.equal(state.statusCode, 503);
        assert.equal(pinged, false);
    }
});

test('unresponsive schema metadata is bounded and cannot keep health hanging', async () => {
    const handler = createHealthController({
        checkIndexes: () => new Promise(() => undefined),
        getDatabase: stableDatabase({ command: async () => ({ ok: 1 }) })
    });
    const { response, state } = responseDouble();
    const started = Date.now();
    await handler({} as Request, response);
    assert.equal(state.statusCode, 503);
    assert.ok(Date.now() - started < 2_000);
});

test('unresponsive capacity diagnostics do not make a healthy service unavailable', async () => {
    const handler = createHealthController({
        checkIndexes: async () => true,
        getDatabase: stableDatabase({ command: async () => ({ ok: 1 }) }),
        getResources: () => new Promise(() => undefined)
    });
    const { response, state } = responseDouble();
    const started = Date.now();
    await handler({} as Request, response);
    assert.equal(state.statusCode, 200);
    assert.equal(state.body.resources, null);
    assert.ok(Date.now() - started < 1_000);
});

test('a readiness request that overlaps shutdown cannot return stale success', async () => {
    let draining = false;
    const handler = createHealthController({
        isDraining: () => draining,
        checkIndexes: async () => true,
        getDatabase: stableDatabase({ command: async () => ({ ok: 1 }) }),
        getResources: async () => { draining = true; return { scope: 'process', temporaryStorage: null,
            artwork: { scope: 'process', active: 0, queued: 0, globalLimit: 1, perClientLimit: 1,
                maximumQueued: 1, maximumQueuedPerClient: 1 } }; }
    });
    const { response, state } = responseDouble();
    await handler({} as Request, response);
    assert.equal(state.statusCode, 503);
});

test('repeated timed-out health requests retain only one underlying database command', async () => {
    let calls = 0;
    let now = 0;
    let release!: () => void;
    const handler = createHealthController({
        now: () => now,
        checkIndexes: async () => true,
        getDatabase: stableDatabase({ command: () => {
            calls++;
            return new Promise(resolve => { release = () => resolve({ ok: 1 }); });
        } })
    });
    for (let batch = 0; batch < 3; batch++) {
        await Promise.all(Array.from({ length: 25 }, async () => {
            const { response, state } = responseDouble();
            await handler({} as Request, response);
            assert.equal(state.statusCode, 503);
        }));
    }
    assert.equal(calls, 1);
    release();
    await delay(0);
    now = 1_001;
    const { response, state } = responseDouble();
    const recovered = handler({} as Request, response);
    await delay(0);
    assert.equal(calls, 2);
    release();
    await recovered;
    assert.equal(state.statusCode, 200);
});

test('connection replacement waits for old work and cannot inherit its ready result', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let replacementCalls = 0;
    let database: Pick<Db, 'command'> = { command: () => {
        entered();
        return new Promise(resolve => { release = () => resolve({ ok: 1 }); });
    } };
    const handler = createHealthController({
        checkIndexes: async () => true,
        getDatabase: () => database
    });
    const first = responseDouble();
    const pending = handler({} as Request, first.response);
    await started;
    database = { command: async () => { replacementCalls++; return { ok: 1 }; } };
    const second = responseDouble();
    await handler({} as Request, second.response);
    assert.equal(second.state.statusCode, 503);
    assert.equal(replacementCalls, 0);
    release();
    await pending;
    assert.equal(first.state.statusCode, 503);
    const recovered = responseDouble();
    await handler({} as Request, recovered.response);
    assert.equal(recovered.state.statusCode, 200);
    assert.equal(replacementCalls, 1);
});

test('an expired schema probe never starts a late ping after its HTTP deadline', async () => {
    let release!: () => void;
    let calls = 0;
    const handler = createHealthController({
        checkIndexes: () => new Promise(resolve => { release = () => resolve(true); }),
        getDatabase: stableDatabase({ command: async () => { calls++; return { ok: 1 }; } })
    });
    const { response, state } = responseDouble();
    await handler({} as Request, response);
    assert.equal(state.statusCode, 503);
    release();
    await delay(0);
    assert.equal(calls, 0);
});
