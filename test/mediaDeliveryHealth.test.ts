import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';

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
        getDatabase: () => ({
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
