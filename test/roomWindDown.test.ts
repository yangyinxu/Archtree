import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import express from 'express';
import { SocialError } from '../src/contracts/socialV1';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { installRoomWindDown, type RoomWindDownOptions } from '../src/realtime/roomWindDown';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { startServer } from '../src/server';

const waitFor = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        if (Date.now() > deadline) assert.fail(`Wind-down test deadline exceeded: ${label}.`);
        await new Promise(resolve => setTimeout(resolve, 2));
    }
};

/** Scripted storage and lease outcomes isolate scheduling from the separately tested durable sweep. */
const fixture = (script: { open: Array<boolean | Error>; acquire?: Array<number | null | Error>; sweep?: Array<Error | undefined> }) => {
    const calls = { open: 0, acquire: 0, sweep: 0, release: 0 };
    const logs: string[] = [];
    const metrics = createRoomGatewayMetrics(Date.now, () => false);
    const next = <T>(values: T[] | undefined, fallback: T) => values?.length ? values.shift()! : fallback;
    const options: RoomWindDownOptions = {
        metrics, intervalMs: 5, log: entry => logs.push(entry.state),
        hasOpenRooms: async () => { calls.open++; const value = next(script.open, false); if (value instanceof Error) throw value; return value; },
        acquire: async () => { calls.acquire++; const value = next(script.acquire, 7); if (value instanceof Error) throw value; return value; },
        release: async () => { calls.release++; },
        api: { sweep: async () => { calls.sweep++; const failure = next(script.sweep, undefined); if (failure) throw failure; } }
    };
    const server = createServer();
    const lifecycle = new ServerLifecycle();
    const windDown = installRoomWindDown(server, lifecycle, options);
    return { calls, logs, metrics, server, lifecycle, windDown };
};

test('a disabled start with no open room completes without taking the room authority', async () => {
    const run = fixture({ open: [false] });
    await waitFor(() => run.logs.includes('complete'), 'completion');
    assert.deepEqual(run.logs, ['complete']);
    assert.equal(run.calls.acquire, 0); assert.equal(run.calls.sweep, 0);
    assert.equal(run.metrics.snapshot().authorityState, 'inactive');
    await new Promise(resolve => setTimeout(resolve, 30));
    // A disabled release cannot open a room, so the schedule stops instead of polling forever.
    assert.equal(run.calls.open, 1);
    run.windDown.stop();
});

test('open rooms are swept under a renewed lease until none remain, then the lease is released', async () => {
    const run = fixture({ open: [true, true, true, false] });
    await waitFor(() => run.logs.includes('complete'), 'completion');
    assert.deepEqual(run.logs, ['started', 'complete']);
    assert.equal(run.calls.sweep, 2); assert.equal(run.calls.acquire, 2); assert.equal(run.calls.release, 1);
    const snapshot = run.metrics.snapshot();
    assert.equal(snapshot.authorityState, 'inactive');
    assert.equal(typeof snapshot.lastSuccessfulSweepAgeMs, 'number');
    assert.deepEqual(snapshot.failures, { authorityAcquisition: 0, sweep: 0, refresh: 0, report: 0, disconnect: 0 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(run.calls.sweep, 2);
    run.windDown.stop();
});

test('a lease held elsewhere, a failed sweep and a storage outage are each retried by a later tick', async () => {
    const run = fixture({
        open: [new SocialError(503, 'room_unavailable'), true, true, true, true, true, false],
        acquire: [null, new SocialError(503, 'room_authority_unavailable'), 7, 7],
        sweep: [new SocialError(503, 'room_unavailable')]
    });
    const states = new Set<string>();
    const observe = setInterval(() => states.add(run.metrics.snapshot().authorityState), 1);
    await waitFor(() => run.logs.includes('complete'), 'completion');
    clearInterval(observe);
    // No sweep may run without a lease; the one successful sweep happens only after a fresh acquisition.
    assert.equal(run.calls.acquire, 4); assert.equal(run.calls.sweep, 2);
    assert.deepEqual(run.metrics.snapshot().failures, { authorityAcquisition: 2, sweep: 2, refresh: 0, report: 0, disconnect: 0 });
    assert.ok(states.has('unavailable'));
    assert.equal(run.metrics.snapshot().authorityState, 'inactive');
    assert.deepEqual(run.logs, ['started', 'complete']);
    run.windDown.stop();
});

test('stopping ends scheduling and keeps the stopped diagnostic state', async () => {
    const run = fixture({ open: Array.from({ length: 1_000 }, () => true) });
    await waitFor(() => run.calls.sweep >= 1, 'first sweep');
    run.windDown.stop();
    const sweeps = run.calls.sweep;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(run.calls.sweep <= sweeps + 1, 'At most the tick already in progress may finish.');
    assert.equal(run.metrics.snapshot().authorityState, 'stopped');
    await run.windDown.release();
    assert.equal(run.calls.release, 1);
});

test('realtime upgrades get an empty 503 and never reach the HTTP application', async () => {
    const run = fixture({ open: [false] });
    let applicationRequests = 0;
    run.server.on('request', express().use((_req, res) => { applicationRequests++; res.status(401).json({ code: 'session_required' }); }));
    await new Promise<void>(resolve => run.server.listen(0, '127.0.0.1', resolve));
    try {
        const address = run.server.address(); assert.ok(address && typeof address !== 'string');
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const request = httpRequest(`http://127.0.0.1:${address.port}/api/social/v1/realtime`, { headers: {
                Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol': `archtree-room-v1, ${'A'.repeat(43)}`,
                Origin: `http://127.0.0.1:${address.port}` } });
            request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('A disabled process must not upgrade.')); });
            request.once('response', incoming => {
                let body = '';
                incoming.setEncoding('utf8');
                incoming.on('data', chunk => { body += chunk; });
                incoming.once('end', () => resolve({ status: incoming.statusCode!, body }));
            });
            request.once('error', reject);
            request.end();
        });
        assert.deepEqual(response, { status: 503, body: '' });
        assert.equal(applicationRequests, 0);
    } finally {
        await run.lifecycle.stop(run.server, async () => undefined, 1_000, 1_000);
    }
    assert.equal(run.metrics.snapshot().authorityState, 'stopped');
});

test('startup admits the room gateway only with both rollout flags and otherwise winds rooms down', async () => {
    const previous = { social: process.env.FINITUDE_SOCIAL_ENABLED, rooms: process.env.FINITUDE_ROOMS_ENABLED };
    try {
        for (const [social, rooms, expected] of [['true', 'true', 'gateway'], ['true', 'false', 'windDown'],
            ['false', 'true', 'windDown'], [undefined, undefined, 'windDown']] as const) {
            for (const [key, value] of [['FINITUDE_SOCIAL_ENABLED', social], ['FINITUDE_ROOMS_ENABLED', rooms]] as const) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
            const events: string[] = [];
            const runtime = (name: string) => () => ({ stop: () => { events.push(`${name}:stop`); }, release: async () => { events.push(`${name}:release`); } });
            let closed = 0;
            const server = await startServer({
                connectDatabase: async () => undefined, closeDatabase: async () => { closed++; events.push('database:close'); },
                createApplication: () => express(), port: 0,
                installRoomGateway: runtime('gateway') as never, installRoomWindDown: runtime('windDown') as never,
                stopped: () => undefined
            });
            process.emit('SIGTERM');
            await waitFor(() => closed === 1, 'shutdown');
            // Exactly one room runtime exists, and its lease is released before the database closes.
            assert.deepEqual(events, [`${expected}:stop`, `${expected}:release`, 'database:close']);
            assert.equal(server.listening, false);
        }
    } finally {
        for (const [key, value] of [['FINITUDE_SOCIAL_ENABLED', previous.social], ['FINITUDE_ROOMS_ENABLED', previous.rooms]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});
