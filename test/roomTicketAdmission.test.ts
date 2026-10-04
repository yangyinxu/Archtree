import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after, before, type TestContext } from 'node:test';
import express from 'express';
import { handleApplicationError } from '../src/app';
import type { RoomActor, RoomApi } from '../src/contracts/roomV1';
import { SocialError } from '../src/contracts/socialV1';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { createSocialOperations } from '../src/realtime/socialOperations';
import type { RealtimeSeatRefusal } from '../src/config/socialCapacity';
import { realtimeSeats } from '../src/realtime/realtimeSeats';
import { createRoomRouter, type RoomRouterOptions } from '../src/routes/roomRoutes';

const capacity = { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 };
const userId = 'a'.repeat(24);
const clientId = 'synthetic-ticket-client-001';
const previous = { social: process.env.FINITUDE_SOCIAL_ENABLED, rooms: process.env.FINITUDE_ROOMS_ENABLED };
before(() => { process.env.FINITUDE_SOCIAL_ENABLED = 'true'; process.env.FINITUDE_ROOMS_ENABLED = 'true'; });
after(() => {
    for (const [key, value] of Object.entries({ FINITUDE_SOCIAL_ENABLED: previous.social, FINITUDE_ROOMS_ENABLED: previous.rooms })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

/** Drives the real ticket route behind a synthetic authenticated viewer, with an injected seat rule and ticket store. */
const listen = async (t: TestContext, options: Partial<RoomRouterOptions> & { refusal?: RealtimeSeatRefusal | null } = {}) => {
    resetRateLimitWindowsForTests();
    const operations = createSocialOperations({ log: () => undefined, metrics: createRoomGatewayMetrics() });
    const issued: RoomActor[] = [];
    const asked: RoomActor[] = [];
    const app = express();
    app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId, sessionId: 'b'.repeat(24), email: 'fixture@example.test', role: 'user' };
        next();
    });
    app.use('/api/social/v1', createRoomRouter({} as RoomApi, {
        capacity, operations, seatCheck: options.seatCheck ?? (async actor => { asked.push(actor); return options.refusal ?? null; }),
        issueTicket: options.issueTicket ?? (async actor => { issued.push(actor); return { ticket: 'T'.repeat(43), expiresAt: new Date(0).toISOString() }; })
    }));
    app.use(handleApplicationError);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const request = async () => {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social/v1/realtime-tickets`, {
            method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId })
        });
        return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() as Record<string, unknown> };
    };
    return { request, operations, issued, asked };
};

test('an available seat issues the ticket for the requesting client', async t => {
    const fixture = await listen(t);
    const response = await fixture.request();
    assert.equal(response.status, 200);
    assert.equal(fixture.issued.length, 1);
    assert.deepEqual(fixture.asked, [{ userId, sessionId: 'b'.repeat(24), clientId }], 'The seat rule sees the client a replacement would match.');
});

test('a full process refuses before issuance with a retry delay and counts the refusal', async t => {
    const fixture = await listen(t, { refusal: 'capacity' });
    const response = await fixture.request();
    assert.deepEqual([response.status, response.retryAfter, response.body.code], [503, '30', 'realtime_capacity']);
    assert.equal(fixture.issued.length, 0, 'No ticket transaction runs for a refused seat.');
    const counts = fixture.operations.take();
    assert.equal(counts.ticketFailures.capacity, 1);
    assert.equal(counts.capacityRejections.sockets, 1);
    assert.deepEqual(counts.rejections, { realtime_capacity: 1 });
});

test('an account past its socket share gets the same client response without a capacity event', async t => {
    const fixture = await listen(t, { refusal: 'perAccount' });
    const response = await fixture.request();
    assert.deepEqual([response.status, response.retryAfter, response.body.code], [503, '30', 'realtime_capacity']);
    assert.equal(fixture.issued.length, 0);
    const counts = fixture.operations.take();
    assert.deepEqual([counts.ticketFailures.perAccount, counts.ticketFailures.capacity, counts.capacityRejections.sockets], [1, 0, 0]);
});

test('without an installed gateway the route issues tickets, and an installed gateway\'s rule applies by default', async t => {
    resetRateLimitWindowsForTests();
    const operations = createSocialOperations({ log: () => undefined, metrics: createRoomGatewayMetrics() });
    const app = express();
    app.use((req, _res, next) => {
        (req as AuthenticatedRequest).auth = { userId, sessionId: 'b'.repeat(24), email: 'fixture@example.test', role: 'user' };
        next();
    });
    app.use('/api/social/v1', createRoomRouter({} as RoomApi, { capacity, operations,
        issueTicket: async () => ({ ticket: 'T'.repeat(43), expiresAt: new Date(0).toISOString() }) }));
    app.use(handleApplicationError);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const request = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social/v1/realtime-tickets`, {
        method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId })
    })).status;
    assert.equal(await request(), 200);
    const uninstall = realtimeSeats.install(async () => 'capacity');
    try { assert.equal(await request(), 503); } finally { uninstall(); }
    assert.equal(await request(), 200, 'A stopped gateway uninstalls its rule.');
});

test('issuance failures are classified without changing the existing responses', async t => {
    const cases = [
        { error: new SocialError(429, 'ticket_limit'), status: 429, kind: 'limit' },
        { error: new SocialError(401, 'session_required'), status: 401, kind: 'session' },
        { error: new Error('Synthetic private database failure.'), status: 500, kind: 'unavailable' }
    ] as const;
    for (const { error, status, kind } of cases) {
        const fixture = await listen(t, { issueTicket: async () => { throw error; } });
        const response = await fixture.request();
        assert.equal(response.status, status, kind);
        assert.doesNotMatch(JSON.stringify(response.body), /Synthetic private/);
        assert.equal(fixture.operations.take().ticketFailures[kind], 1, kind);
    }
});
