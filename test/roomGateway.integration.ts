import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { WebSocket } from 'ws';
import type { RoomActor, RoomApi } from '../src/contracts/roomV1';
import { SocialError } from '../src/contracts/socialV1';
import { createRoomService } from '../src/application/rooms/roomService';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import { installRoomGateway } from '../src/realtime/roomGateway';
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

/** Real TCP/WebSocket handshakes isolate admission races from the separately tested durable room API. */
const fixture = async (options: { api?: RoomApi; actor?: RoomActor; acquire?: () => Promise<number | null> } = {}) => {
    const lifecycle = new ServerLifecycle();
    const server = createServer((_req, res) => res.writeHead(404).end());
    const transports: Socket[] = []; server.on('connection', socket => { transports.push(socket); });
    const sockets: WebSocket[] = [];
    let held = false;
    const redemptions: Array<() => void> = [];
    let sequence = 0;
    const api = options.api ?? { currentRoom: async () => null, sweep: async () => undefined, disconnected: async () => undefined } as unknown as RoomApi;
    const gateway = installRoomGateway(server, lifecycle, { api, acquire: options.acquire ?? (async () => 1), release: async () => undefined,
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
    return { lifecycle, server, transports, sockets, connect, redemptions, hold: () => { held = true; },
        stop: async () => {
            held = false; redemptions.splice(0).forEach(resolve => resolve());
            await lifecycle.stop(server, async () => {
                assert.ok(transports.every(socket => socket.destroyed), 'Every upgrade transport must stop before database close.');
            }, 1000, 1000);
            for (const socket of sockets) socket.terminate(); gateway.stop();
        } };
};

test('capacity is rechecked after concurrent ticket redemption for both source-IP and global socket limits', async () => {
    for (const global of [false, true]) {
        const gateway = await fixture();
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
            process.env[flag] = 'false';
            assert.equal(await gateway.connect('192.0.2.2').result, 503);
            await waitFor(() => admitted.socket.readyState === WebSocket.CLOSED);
        } finally { process.env[flag] = 'true'; await gateway.stop(); }
    }
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
            }
        } finally { await gateway.stop(); }
    }
});
