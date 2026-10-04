import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { WebSocket } from 'ws';
import express from 'express';
import type { RoomActor, RoomApi } from '../src/contracts/roomV1';
import { SocialError } from '../src/contracts/socialV1';
import { createRoomService } from '../src/application/rooms/roomService';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import { installRoomGateway } from '../src/realtime/roomGateway';
import { createRoomGatewayMetrics, type RoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { createSocialOperations, type SocialOperations } from '../src/realtime/socialOperations';
import type { SocialCapacity } from '../src/config/socialCapacity';
import type { OperationalLogEntry } from '../src/infrastructure/operationalLog';
import { createHealthController } from '../src/controllers/healthController';
import { notifyRoomChanges } from '../src/realtime/roomEvents';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let mongo: MongoReplicaSetHarness;
const previous = { social: process.env.FINITUDE_SOCIAL_ENABLED, rooms: process.env.FINITUDE_ROOMS_ENABLED, proxy: process.env.TRUST_PROXY_HOPS };
before(async () => {
    mongo = await startMongoReplicaSet('archtree-room-upgrade-test');
    process.env.FINITUDE_SOCIAL_ENABLED = 'true'; process.env.FINITUDE_ROOMS_ENABLED = 'true'; process.env.TRUST_PROXY_HOPS = '1';
});
after(async () => {
    await mongo?.stop();
    for (const [key, value] of Object.entries({ FINITUDE_SOCIAL_ENABLED: previous.social, FINITUDE_ROOMS_ENABLED: previous.rooms, TRUST_PROXY_HOPS: previous.proxy })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { if (Date.now() > deadline) assert.fail('Gateway test deadline exceeded.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

/**
 * Real TCP/WebSocket handshakes isolate admission races from the separately tested durable room API.
 * Unless a case injects otherwise, every actor's membership lookup succeeds; a socket seated as a member whose
 * reads then show no room gives its seat back only while the general seats are over-full.
 */
const fixture = async (options: { api?: RoomApi; actor?: RoomActor; acquire?: () => Promise<number | null>; metrics?: RoomGatewayMetrics;
    capacity?: SocialCapacity; isRoomMember?: (accountId: string) => Promise<boolean> } = {}) => {
    const lifecycle = new ServerLifecycle();
    const metrics = options.metrics ?? createRoomGatewayMetrics();
    const logged: OperationalLogEntry[] = [];
    const operations: SocialOperations = createSocialOperations({ metrics, log: entry => { logged.push(entry); } });
    const app = express();
    app.get('/health', createHealthController({ getRoomMetrics: metrics.snapshot }));
    const server = createServer(app);
    const transports: Socket[] = []; server.on('connection', socket => { transports.push(socket); });
    const sockets: WebSocket[] = [];
    let held = false;
    const redemptions: Array<() => void> = [];
    let sequence = 0;
    const api = options.api ?? { currentRoom: async () => null, sweep: async () => undefined, disconnected: async () => undefined } as unknown as RoomApi;
    const gateway = installRoomGateway(server, lifecycle, { api, metrics, operations, capacity: options.capacity,
        isRoomMember: options.isRoomMember ?? (async () => true),
        acquire: options.acquire ?? (async () => 1), release: async () => undefined,
        redeemTicket: async () => {
            const actor: RoomActor = options.actor ?? { userId: (++sequence).toString(16).padStart(24, '0'), sessionId: '1'.repeat(24), clientId: randomUUID() };
            if (held) await new Promise<void>(resolve => { redemptions.push(resolve); });
            return actor;
        } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => setTimeout(resolve, 5));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const connect = (ip: string) => {
        const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/social/v1/realtime', ['archtree-room-v1', 'A'.repeat(43)],
            { origin, headers: { 'X-Forwarded-For': ip } });
        sockets.push(socket); socket.on('error', () => undefined);
        const result = new Promise<number>(resolve => {
            socket.once('open', () => resolve(101));
            socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
        });
        return { socket, result };
    };
    return { lifecycle, server, transports, sockets, connect, redemptions, metrics, operations, logged, origin, hold: () => { held = true; },
        stop: async () => {
            held = false; redemptions.splice(0).forEach(resolve => resolve());
            await lifecycle.stop(server, async () => {
                assert.ok(transports.every(socket => socket.destroyed), 'Every upgrade transport must stop before database close.');
            }, 1000, 1000);
            for (const socket of sockets) socket.terminate(); gateway.stop();
        } };
};

/** The fields the gateway reads from a projection, for accounts a case treats as room members. */
const memberRoom = { roomId: 'r_synthetic', epoch: 1, revision: 1, self: { controllerGeneration: 1, isController: true } };
const roomApi = (inRoom: (accountId: string) => boolean = () => true) => ({ currentRoom: async (who: RoomActor) => inRoom(who.userId) ? memberRoom : null,
    sweep: async () => undefined, disconnected: async () => undefined }) as unknown as RoomApi;

test('capacity is rechecked after concurrent ticket redemption for both source-IP and global socket limits', async () => {
    for (const global of [false, true]) {
        // Every account is in a room, so the reserved seats make the 256-socket ceiling reachable.
        const gateway = await fixture({ api: roomApi() });
        try {
            const maximum = global ? 256 : 32;
            for (let index = 0; index < maximum - 1; index += 1) {
                assert.equal(await gateway.connect(global ? `2001:db8::${index}` : '192.0.2.1').result, 101);
            }
            gateway.hold();
            const first = gateway.connect(global ? '198.51.100.1' : '192.0.2.1');
            const second = gateway.connect(global ? '198.51.100.2' : '192.0.2.1');
            await waitFor(() => gateway.redemptions.length === 2);
            gateway.redemptions.splice(0).forEach(resolve => resolve());
            assert.deepEqual((await Promise.all([first.result, second.result])).sort(), [101, 429]);
        } finally { await gateway.stop(); }
    }
});

test('either disabled rollout flag stops existing sockets and denies fresh upgrades', async () => {
    for (const flag of ['FINITUDE_SOCIAL_ENABLED', 'FINITUDE_ROOMS_ENABLED']) {
        const gateway = await fixture();
        try {
            const admitted = gateway.connect('192.0.2.1'); assert.equal(await admitted.result, 101);
            assert.equal(gateway.metrics.snapshot().enabled, true);
            process.env[flag] = 'false';
            assert.equal(gateway.metrics.snapshot().enabled, false);
            assert.equal(await gateway.connect('192.0.2.2').result, 503);
            await waitFor(() => admitted.socket.readyState === WebSocket.CLOSED);
        } finally { process.env[flag] = 'true'; await gateway.stop(); }
    }
});

test('a well-formed handshake from a foreign Origin gets an empty 403 before any ticket redemption', async () => {
    // The rollout runbook's proxy probe relies on this answer: it proves an upgrade reached the
    // gateway without spending a ticket lookup, and differs from Express's JSON 401 for the same path.
    const gateway = await fixture();
    try {
        gateway.hold();
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const request = httpRequest(`${gateway.origin}/api/social/v1/realtime`, { headers: {
                Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol': `archtree-room-v1, ${'A'.repeat(43)}`,
                Origin: 'https://probe.invalid', 'X-Forwarded-For': '192.0.2.9' } });
            request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('A foreign Origin must not upgrade.')); });
            request.once('response', incoming => {
                let body = '';
                incoming.setEncoding('utf8');
                incoming.on('data', chunk => { body += chunk; });
                incoming.once('end', () => resolve({ status: incoming.statusCode!, body }));
            });
            request.once('error', reject);
            request.end();
        });
        assert.deepEqual(response, { status: 403, body: '' });
        assert.equal(gateway.redemptions.length, 0);
    } finally { await gateway.stop(); }
});

test('errors during pending upgrade authentication destroy the socket without escaping as an unhandled event', async () => {
    const gateway = await fixture();
    try {
        gateway.hold(); gateway.connect('192.0.2.1');
        await waitFor(() => gateway.redemptions.length === 1);
        const transport = gateway.transports.at(-1)!;
        assert.doesNotThrow(() => transport.emit('error', new Error('Injected upgrade transport failure.')));
        assert.equal(transport.destroyed, true);
        gateway.redemptions.splice(0).forEach(resolve => resolve());
    } finally { await gateway.stop(); }
});

test('authorized absence is reaffirmed even if an intermediate HTTP membership was never sent on the socket', async () => {
    const gateway = await fixture();
    try {
        const admitted = gateway.connect('192.0.2.1');
        const frames: Array<{ type: string; room: unknown }> = [];
        admitted.socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())); });
        assert.equal(await admitted.result, 101);
        await waitFor(() => frames.some(value => value.type === 'subscribed' && value.room === null));
        notifyRoomChanges();
        await waitFor(() => frames.some(value => value.type === 'snapshot' && value.room === null));
    } finally { await gateway.stop(); }
});

/** A real session plus user-row fence exposes the same Mongo conflict as overlapping room/social reads. */
const authenticatedActor = async (): Promise<RoomActor> => {
    const id = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id: id, role: 'user', email: `room-gateway-${id.toHexString()}@example.test` });
    const sessionId = await AuthSession.create(id.toHexString(), `synthetic-${randomUUID()}`, new Date(Date.now() + 60_000));
    return { userId: id.toHexString(), sessionId, clientId: randomUUID() };
};

test('actual Mongo write-conflict exhaustion repairs a fresh authorized read without closing its valid socket', async () => {
    const actor = await authenticatedActor(); const real = createRoomService();
    let reads = 0; let failure: unknown;
    const gateway = await fixture({ actor, api: { ...real, currentRoom: async who => {
        reads += 1;
        try { return await real.currentRoom(who); } catch (error) { failure = error; throw error; }
    } } });
    const lock = getDatabaseClient().startSession();
    try {
        const admitted = gateway.connect('192.0.2.61');
        const frames: Array<{ type: string; room: unknown }> = [];
        admitted.socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())); });
        assert.equal(await admitted.result, 101);
        await waitFor(() => frames.some(value => value.type === 'subscribed'));
        const before = reads;
        lock.startTransaction();
        await getDb()!.collection('users').updateOne({ _id: new ObjectId(actor.userId) }, { $inc: { listenerMutationRevision: 1 } }, { session: lock });
        notifyRoomChanges();
        await waitFor(() => failure !== undefined);
        assert.ok(failure instanceof SocialError && failure.statusCode === 503 && failure.code === 'room_unavailable');
        assert.equal(admitted.socket.readyState, WebSocket.OPEN);
        await lock.commitTransaction();
        await waitFor(() => reads > before + 1 && frames.some(value => value.type === 'snapshot' && value.room === null));
        assert.equal(admitted.socket.readyState, WebSocket.OPEN);
    } finally { if (lock.inTransaction()) await lock.abortTransaction(); await lock.endSession(); await gateway.stop(); }
});

test('revoked authentication closes immediately while repeated availability errors have a finite repair bound', async () => {
    for (const kind of ['revoked', 'unavailable', 'authority'] as const) {
        const actor = await authenticatedActor(); const real = createRoomService(); let mode = false; let failedReads = 0;
        const failedAt: number[] = [];
        const gateway = await fixture({ actor, api: { ...real, currentRoom: async who => {
            if (mode) {
                failedReads += 1;
                failedAt.push(Date.now());
                if (kind !== 'revoked') throw new SocialError(503, kind === 'authority' ? 'room_authority_unavailable' : 'room_unavailable');
            }
            return real.currentRoom(who);
        } } });
        try {
            const admitted = gateway.connect('192.0.2.62');
            let subscribed = false; let code: number | undefined;
            admitted.socket.on('message', bytes => { if (JSON.parse(bytes.toString()).type === 'subscribed') subscribed = true; });
            admitted.socket.on('close', value => { code = value; });
            assert.equal(await admitted.result, 101); await waitFor(() => subscribed);
            mode = true;
            if (kind === 'revoked') await AuthSession.revokeById(actor.userId, actor.sessionId);
            else notifyRoomChanges();
            await waitFor(() => code !== undefined);
            assert.equal(code, kind === 'revoked' ? 1008 : kind === 'authority' ? 1012 : 1013);
            assert.equal(failedReads, kind === 'unavailable' ? 3 : 1);
            if (kind === 'unavailable') {
                assert.ok(failedAt[1] - failedAt[0] >= 100, 'First repair must back off instead of immediately repeating the conflict.');
                assert.ok(failedAt[2] - failedAt[1] >= 200, 'Final repair uses the longer bounded backoff.');
            }
        } finally { await gateway.stop(); }
    }
});

const heartbeatReport = { roomId: 'room-test', memberId: 'member-test', controllerGeneration: 1, locallyPaused: false };
const readinessReport = { roomId: 'room-test', memberId: 'member-test', controllerGeneration: 1, expectedEpoch: 1,
    preparationId: 'current', playbackGeneration: 1, entryId: 'entry-test', mediaRevision: `mr_${'a'.repeat(32)}`, sequence: 1, ready: true };

test('heartbeat and readiness repair actual Mongo write conflicts with the same immutable report and keep the socket', async () => {
    for (const kind of ['heartbeat', 'ready'] as const) {
        const actor = await authenticatedActor(); const real = createRoomService({ assertAuthority: async () => 1 });
        const observed: unknown[] = []; let failed: unknown; let completed = 0;
        const api: RoomApi = { ...real, [kind]: async (who: RoomActor, input: never) => {
            observed.push(input);
            try { await real[kind](who, input); completed++; } catch (error) { failed = error; throw error; }
        } };
        const gateway = await fixture({ actor, api }); const lock = getDatabaseClient().startSession();
        try {
            const admitted = gateway.connect('192.0.2.71'); let subscribed = false;
            admitted.socket.on('message', bytes => { if (JSON.parse(bytes.toString()).type === 'subscribed') subscribed = true; });
            assert.equal(await admitted.result, 101); await waitFor(() => subscribed);
            lock.startTransaction();
            await getDb()!.collection('users').updateOne({ _id: new ObjectId(actor.userId) }, { $inc: { listenerMutationRevision: 1 } }, { session: lock });
            admitted.socket.send(JSON.stringify(kind === 'ready' ? { type: 'ready', report: readinessReport }
                : { type: 'ping', clientTimeMs: Date.now(), heartbeat: heartbeatReport }));
            await waitFor(() => failed !== undefined);
            assert.ok(failed instanceof SocialError && failed.code === 'room_unavailable' && failed.statusCode === 503);
            assert.equal(admitted.socket.readyState, WebSocket.OPEN);
            await lock.commitTransaction();
            await waitFor(() => completed === 1);
            assert.equal(gateway.metrics.snapshot().failures.report, 0, 'A repaired report is not a terminal report failure.');
            assert.equal(observed.length, 2);
            assert.equal(observed[0], observed[1], 'Repair must retain the exact parsed observation object.');
            assert.equal(Object.isFrozen(observed[0]), true);
            assert.equal(admitted.socket.readyState, WebSocket.OPEN);
        } finally { if (lock.inTransaction()) await lock.abortTransaction(); await lock.endSession(); await gateway.stop(); }
    }
});

test('dispatch rejects revoked sessions and uncertain outcomes, bounds failures, and refreshes stale observations', async () => {
    for (const kind of ['revoked', 'unavailable', 'authority', 'uncertain', 'stale', 'removed'] as const) {
        const actor = await authenticatedActor(); const real = createRoomService({ assertAuthority: async () => 1 });
        const attempts: number[] = [];
        const gateway = await fixture({ actor, api: { ...real, ready: async (who, report) => {
            attempts.push(Date.now());
            if (kind === 'revoked') { await AuthSession.revokeById(actor.userId, actor.sessionId); return real.ready(who, report); }
            if (kind === 'stale') throw new SocialError(409, 'stale_controller');
            if (kind === 'removed') throw new SocialError(404, 'room_unavailable');
            throw new SocialError(503, kind === 'unavailable' ? 'room_unavailable'
                : kind === 'uncertain' ? 'mutation_outcome_unknown' : 'room_authority_unavailable');
        } } });
        try {
            const admitted = gateway.connect('192.0.2.72'); let subscribed = false; let absence = false; let code: number | undefined;
            admitted.socket.on('message', bytes => {
                const frame = JSON.parse(bytes.toString());
                if (frame.type === 'subscribed') subscribed = true;
                if (frame.type === 'snapshot' && frame.room === null) absence = true;
            });
            admitted.socket.on('close', value => { code = value; });
            assert.equal(await admitted.result, 101); await waitFor(() => subscribed);
            admitted.socket.send(JSON.stringify({ type: 'ready', report: readinessReport }));
            if (kind === 'stale' || kind === 'removed') {
                await waitFor(() => absence); assert.equal(admitted.socket.readyState, WebSocket.OPEN);
            } else {
                await waitFor(() => code !== undefined);
                assert.equal(code, kind === 'revoked' ? 1008 : kind === 'authority' ? 1012 : 1013);
            }
            assert.equal(gateway.metrics.snapshot().failures.report, ['stale', 'removed'].includes(kind) ? 0 : 1);
            assert.equal(attempts.length, kind === 'unavailable' ? 3 : 1);
            if (kind === 'unavailable') { assert.ok(attempts[1] - attempts[0] >= 100); assert.ok(attempts[2] - attempts[1] >= 200); }
        } finally { await gateway.stop(); }
    }
});

test('timer contention requires a fresh lease and repairs on a later tick with a finite failure bound', async () => {
    for (const kind of ['recover', 'unavailable', 'authority'] as const) {
        let active = false; let failures = 0; let recovered = false; let acquisitions = 0;
        const api = { currentRoom: async () => null, disconnected: async () => undefined, sweep: async () => {
            if (!active) return;
            if (kind === 'recover' && failures === 2) { recovered = true; return; }
            failures++; throw new SocialError(503, 'room_unavailable');
        } } as unknown as RoomApi;
        const gateway = await fixture({ api, acquire: async () => { acquisitions++; return active && kind === 'authority' ? null : 1; } });
        try {
            const admitted = gateway.connect('192.0.2.73'); let subscribed = false; let code: number | undefined;
            admitted.socket.on('message', bytes => { if (JSON.parse(bytes.toString()).type === 'subscribed') subscribed = true; });
            admitted.socket.on('close', value => { code = value; });
            assert.equal(await admitted.result, 101); await waitFor(() => subscribed); active = true;
            if (kind === 'recover') {
                await waitFor(() => recovered); assert.equal(admitted.socket.readyState, WebSocket.OPEN); assert.equal(failures, 2);
                assert.ok(acquisitions >= 3, 'Every deferred timer must immediately revalidate the live lease.');
            } else {
                await waitFor(() => code !== undefined);
                assert.equal(code, kind === 'authority' ? 1012 : 1013);
                assert.equal(failures, kind === 'authority' ? 1 : 3);
                assert.equal(gateway.metrics.snapshot().failures.authorityAcquisition, kind === 'authority' ? 1 : 0);
            }
        } finally { await gateway.stop(); }
    }
});


test('room health observes authority and timer failure then recovery while ordinary HTTP stays ready', async () => {
    let now = 1_000;
    let failSweep = false;
    let failAuthority = false;
    const metrics = createRoomGatewayMetrics(() => now);
    const api = { currentRoom: async () => null, disconnected: async () => undefined, sweep: async () => {
        if (failSweep) throw new SocialError(503, 'room_unavailable');
    } } as unknown as RoomApi;
    const gateway = await fixture({ api, metrics, acquire: async () => {
        if (failAuthority) throw new Error('Synthetic private failure details must never enter health.');
        return 1;
    } });
    try {
        await waitFor(() => metrics.snapshot().lastSuccessfulSweepAgeMs === 0);
        assert.equal(metrics.snapshot().authorityState, 'ready');
        now = 2_500;
        failSweep = true;
        failAuthority = true;
        await waitFor(() => metrics.snapshot().authorityState === 'unavailable');
        const failed = await fetch(`${gateway.origin}/health`);
        assert.equal(failed.status, 200);
        const body: any = await failed.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.rooms.authorityState, 'unavailable');
        assert.equal(body.rooms.failures.sweep, 1);
        assert.equal(body.rooms.failures.authorityAcquisition, 1);
        assert.equal(body.rooms.lastSuccessfulSweepAgeMs, 1_500);
        assert.doesNotMatch(JSON.stringify(body.rooms), /private|details|roomId|userId|sessionId|stack/);
        now = 3_000;
        failSweep = false;
        failAuthority = false;
        await waitFor(() => metrics.snapshot().authorityState === 'ready' && metrics.snapshot().lastSuccessfulSweepAgeMs === 0);
        const recovered = await fetch(`${gateway.origin}/health`);
        assert.equal(recovered.status, 200);
        const recoveredBody: any = await recovered.json();
        assert.equal(recoveredBody.rooms.authorityState, 'ready');
        assert.equal(recoveredBody.rooms.lastSuccessfulSweepAgeMs, 0);
        assert.equal(recoveredBody.rooms.failures.sweep, 1);
        assert.equal(recoveredBody.rooms.failures.authorityAcquisition, 1);
    } finally { await gateway.stop(); }
    assert.equal(metrics.snapshot().authorityState, 'stopped');
});

test('terminal refresh and disconnect failures retain only their fixed counters', async () => {
    let failRefresh = false;
    const gateway = await fixture({ api: {
        currentRoom: async () => {
            if (failRefresh) throw new Error('Synthetic private refresh payload.');
            return null;
        },
        sweep: async () => undefined,
        disconnected: async () => { throw new Error('Synthetic private disconnect payload.'); }
    } as unknown as RoomApi });
    try {
        const admitted = gateway.connect('192.0.2.81');
        let subscribed = false;
        admitted.socket.on('message', bytes => { if (JSON.parse(bytes.toString()).type === 'subscribed') subscribed = true; });
        assert.equal(await admitted.result, 101);
        await waitFor(() => subscribed);
        failRefresh = true;
        notifyRoomChanges();
        await waitFor(() => gateway.metrics.snapshot().failures.disconnect === 1);
        assert.equal(gateway.metrics.snapshot().failures.refresh, 1);
        assert.doesNotMatch(JSON.stringify(gateway.metrics.snapshot()), /private|payload|192\.0\.2|userId|sessionId/);
    } finally { await gateway.stop(); }
});

test('late authority acquisition cannot overwrite the stopped diagnostic state', async () => {
    let release!: () => void;
    const gateway = await fixture({ acquire: () => new Promise(resolve => { release = () => resolve(1); }) });
    const stopped = gateway.stop();
    release();
    await stopped;
    assert.equal(gateway.metrics.snapshot().authorityState, 'stopped');
});

test('a configured socket cap refuses extra sockets and keeps reserved seats for room members', async () => {
    // Four sockets with one two-member room allowed: two general seats, two held for room participants.
    const members = new Set([4, 5].map(value => value.toString(16).padStart(24, '0')));
    const lookups: string[] = [];
    const gateway = await fixture({ capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 }, api: roomApi(id => members.has(id)),
        isRoomMember: async accountId => { lookups.push(accountId); return members.has(accountId); } });
    try {
        const outcomes: number[] = [];
        for (let index = 0; index < 6; index += 1) outcomes.push(await gateway.connect(`192.0.2.${100 + index}`).result);
        // Accounts 1–2 take the general seats without a lookup, account 3 is not in a room, accounts 4–5 are
        // members using the reserved seats, and the sixth attempt meets the hard cap without a lookup.
        assert.deepEqual(outcomes, [101, 101, 429, 101, 101, 429]);
        assert.equal(lookups.length, 3, 'Only sockets past the general seats need a membership lookup.');
        assert.equal(gateway.metrics.snapshot().openSockets, 4);
        const counts = gateway.operations.take();
        assert.equal(counts.socketsOpened, 4);
        assert.equal(counts.peakSockets, 4);
        assert.equal(counts.upgradeRejections.capacity, 2);
        assert.equal(counts.capacityRejections.sockets, 2);
        assert.deepEqual(gateway.logged.filter(entry => entry.category === 'social_capacity'),
            [{ category: 'social_capacity', limit: 'sockets', maximum: 4 }], 'A burst of refusals writes one capacity line.');

        gateway.sockets[0].close(1000);
        await waitFor(() => gateway.metrics.snapshot().openSockets === 3);
        assert.equal(gateway.operations.take().socketCloses.normal, 1);
    } finally { await gateway.stop(); }
});

test('a non-member past the general seats is refused even while the hard cap has room', async () => {
    const gateway = await fixture({ capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 },
        isRoomMember: async () => { throw new Error('Synthetic unavailable membership lookup.'); } });
    try {
        assert.equal(await gateway.connect('192.0.2.120').result, 101);
        assert.equal(await gateway.connect('192.0.2.121').result, 101);
        // An unavailable lookup cannot prove membership, so the reserved seats stay closed.
        assert.equal(await gateway.connect('192.0.2.122').result, 429);
        assert.equal(gateway.operations.take().upgradeRejections.capacity, 1);
    } finally { await gateway.stop(); }
});

test('operations classify refused upgrades and record fanout passes without identities', async () => {
    const gateway = await fixture();
    try {
        const admitted = gateway.connect('192.0.2.130');
        const frames: Array<{ type: string }> = [];
        admitted.socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())); });
        assert.equal(await admitted.result, 101);
        await waitFor(() => frames.some(frame => frame.type === 'subscribed'));
        gateway.operations.take();
        notifyRoomChanges();
        await waitFor(() => frames.some(frame => frame.type === 'snapshot'));
        await waitFor(() => gateway.operations.take().fanoutPasses >= 1);

        const foreign = new WebSocket(gateway.origin.replace('http:', 'ws:') + '/api/social/v1/realtime', ['archtree-room-v1', 'A'.repeat(43)],
            { origin: 'https://probe.invalid', headers: { 'X-Forwarded-For': '192.0.2.131' } });
        foreign.on('error', () => undefined);
        assert.equal(await new Promise<number>(resolve => foreign.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); })), 403);
        process.env.FINITUDE_ROOMS_ENABLED = 'false';
        assert.equal(await gateway.connect('192.0.2.132').result, 503);
        await waitFor(() => admitted.socket.readyState === WebSocket.CLOSED);
        process.env.FINITUDE_ROOMS_ENABLED = 'true';
        const counts = gateway.operations.take();
        assert.equal(counts.upgradeRejections.unauthorized, 1);
        assert.equal(counts.upgradeRejections.unavailable, 1);
        assert.equal(counts.socketCloses.goingAway, 1, 'A rollout stop closes sockets as going away.');
        assert.doesNotMatch(JSON.stringify([counts, gateway.logged]), /192\.0\.2|probe\.invalid|0{20}/);
    } finally { process.env.FINITUDE_ROOMS_ENABLED = 'true'; await gateway.stop(); }
});

test('replacing a client\'s own socket at the socket cap needs no new seat', async () => {
    const actor: RoomActor = { userId: 'c'.repeat(24), sessionId: 'd'.repeat(24), clientId: randomUUID() };
    const gateway = await fixture({ actor, capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 1 } });
    try {
        const first = gateway.connect('192.0.2.140');
        assert.equal(await first.result, 101);
        const closed = new Promise<number>(resolve => first.socket.once('close', code => resolve(code)));
        assert.equal(await gateway.connect('192.0.2.140').result, 101, 'A reconnect replaces the half-open socket.');
        assert.equal(await closed, 1000);
        await waitFor(() => gateway.metrics.snapshot().openSockets === 1);
        assert.equal(gateway.operations.take().upgradeRejections.capacity, 0);
    } finally { await gateway.stop(); }
});

test('a member socket gives its seat back after its room ends only while the general seats are over-full', async () => {
    // Four sockets: two general seats, two reserved. Accounts 3 and 4 are members seated in the reserved seats.
    const id = (value: number) => value.toString(16).padStart(24, '0');
    const members = new Set([id(3), id(4)]);
    const gateway = await fixture({ capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 },
        api: roomApi(accountId => members.has(accountId)), isRoomMember: async accountId => members.has(accountId) });
    try {
        for (let index = 0; index < 4; index += 1) assert.equal(await gateway.connect(`192.0.2.${150 + index}`).result, 101);
        const codes = gateway.sockets.map(socket => new Promise<number>(resolve => socket.once('close', code => resolve(code))));
        gateway.sockets[0].close(1000);
        await waitFor(() => gateway.metrics.snapshot().openSockets === 3);
        // One general socket left: account 3's socket now fits the general seats and stays.
        members.delete(id(3)); notifyRoomChanges();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(gateway.sockets[2].readyState, WebSocket.OPEN);
        // Account 4 leaving too would leave three sockets for two general seats: its socket delivers the
        // absence and is then closed as busy.
        const frames: Array<{ type: string; room?: unknown }> = [];
        gateway.sockets[3].on('message', bytes => { frames.push(JSON.parse(bytes.toString())); });
        members.delete(id(4)); notifyRoomChanges();
        assert.equal(await codes[3], 1013);
        assert.deepEqual(frames.filter(frame => frame.type === 'snapshot'), [{ type: 'snapshot', room: null }]);
        await waitFor(() => gateway.metrics.snapshot().openSockets === 2);
        assert.equal(gateway.sockets[1].readyState, WebSocket.OPEN);
        assert.equal(gateway.sockets[2].readyState, WebSocket.OPEN);
        assert.equal(gateway.operations.take().socketCloses.unavailable, 1);
        // A fresh non-member now waits, while a new member still finds a reserved seat.
        assert.equal(await gateway.connect('192.0.2.160').result, 429);
        members.add(id(6));
        assert.equal(await gateway.connect('192.0.2.161').result, 101);
    } finally { await gateway.stop(); }
});
