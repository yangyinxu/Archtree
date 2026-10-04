import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId, type ClientSession } from 'mongodb';
import { createRoomService } from '../src/application/rooms/roomService';
import type { RoomActor, RoomMediaDescriptor } from '../src/contracts/roomV1';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import type { RoomDocument, RoomMemberDocument } from '../src/repositories/social/roomDocuments';
import { createRoomAuthority } from '../src/realtime/roomAuthority';
import { createSocialOperations } from '../src/realtime/socialOperations';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

/*
 * Free-tier MongoDB Atlas throttles a cluster above 100 operations per second, so the realtime design's
 * per-room and per-socket database operations decide how many rooms and sockets one deployment can afford.
 * These cases count operations on an isolated mongod with the server's own opcounters and pin the budgets
 * the capacity estimate in docs/testing/t4g-micro-capacity-screen.md relies on. A failure means a change
 * made rooms or sockets more expensive: re-derive the estimate and the shipped caps before raising a bound.
 */

let harness: MongoReplicaSetHarness | undefined;
const now = Date.now();
const db = () => getDb()!;
const operations = createSocialOperations({ log: () => undefined, metrics: createRoomGatewayMetrics() });
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

/** Server-wide operation count; the reading's own serverStatus command is excluded from the result. */
const operationCount = async () => {
    const status = await db().admin().command({ serverStatus: 1 });
    const counters = status.opcounters as Record<string, number>;
    return ['insert', 'query', 'update', 'delete', 'getmore', 'command'].reduce((total, name) => total + Number(counters[name]), 0);
};
/** Average operations per call over several calls, so driver heartbeats cannot skew one sample. */
const perCall = async (calls: number, work: () => Promise<unknown>) => {
    const before = await operationCount();
    for (let index = 0; index < calls; index += 1) await work();
    const total = await operationCount() - before - 1;
    return total / calls;
};

const media: RoomMediaDescriptor = { mediaTrackId: new ObjectId().toHexString(), title: 'Synthetic room audio',
    mediaRevision: `mr_${'1'.repeat(32)}`, durationMs: 3_600_000, streamUrl: '/content/mediaTrack/stream/synthetic', mediaType: 'Audio' };
// The production resolver also reads one audioTracks document per playing room.
const resolveMedia = async (mediaTrackId: string, session?: ClientSession) => {
    const row = await db().collection('audioTracks').findOne({ _id: new ObjectId(mediaTrackId) }, { session });
    return row ? media : null;
};

before(async () => { harness = await startMongoReplicaSet('archtree-room-capacity-budget-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => {
    for (const name of ['users', 'authSessions', 'socialProfiles', 'socialRooms', 'socialRoomParticipation', 'socialOutbox', 'audioTracks', 'socialAuthority']) {
        await db().collection(name).deleteMany({});
    }
    await db().collection('audioTracks').insertOne({ _id: new ObjectId(media.mediaTrackId) });
});

/** One connected listener with a live session, an active social card and, optionally, a room seat. */
const listener = async (): Promise<{ actor: RoomActor; member: RoomMemberDocument }> => {
    const user = new ObjectId();
    await db().collection('users').insertOne({ _id: user, role: 'user', email: `${user.toHexString()}@budget.invalid` });
    const sessionId = await AuthSession.create(user.toHexString(), `synthetic-${randomUUID()}`, new Date(now + 3_600_000));
    const socialId = id('s');
    await db().collection('socialProfiles').insertOne({ _id: socialId as never, accountId: user.toHexString(), handle: socialId.slice(2, 14),
        alias: 'Synthetic listener', active: true, discoverable: false, revision: 1, updatedAt: new Date(now) });
    const actor: RoomActor = { userId: user.toHexString(), sessionId, clientId: randomUUID() };
    return { actor, member: { membershipId: id('m'), accountId: actor.userId, socialId, controllerSessionId: sessionId,
        controllerClientId: actor.clientId, controllerGeneration: 1, joinedAt: new Date(now), lastSeenAt: new Date(now),
        locallyPaused: false, connectionPresent: true } };
};

/** A steady open room: every member connected, nothing due, so each sweep takes the read-only path. */
const openRoom = async (members: number, epoch: number, playing: boolean) => {
    const people = [];
    for (let index = 0; index < members; index += 1) people.push(await listener());
    const entryId = id('e');
    const room: RoomDocument = { _id: id('r'), state: 'open', epoch, revision: 1, hostMembershipId: people[0].member.membershipId,
        controlMode: 'hostOnly', controlGeneration: 1, queueRevision: 1, playbackGeneration: 1, members: people.map(person => person.member),
        queue: [{ ...media, entryId }], songRequests: [], events: [],
        timeline: { entryId, state: playing ? 'playing' : 'paused', positionMs: 0, anchorServerTimeMs: now },
        preparation: null, transfer: null, hostAbsentSince: null, hostSuspended: false, createdAt: new Date(now), expiresAt: new Date(now + 3_600_000) };
    await db().collection<RoomDocument>('socialRooms').insertOne(room);
    await db().collection('socialRoomParticipation').insertMany(people.map(person =>
        ({ _id: person.actor.userId as never, roomId: room._id, membershipId: person.member.membershipId })));
    return { room, people };
};

const service = async () => {
    const authority = createRoomAuthority(`budget-${randomUUID()}`);
    const epoch = await authority.acquire();
    assert.ok(epoch);
    return { epoch, api: createRoomService({ now: () => now, enabled: () => true, assertAuthority: authority.assert,
        inspectAuthority: authority.inspect, resolveMedia, touchMedia: async () => media, operations }) };
};

/** The gateway refresh: one fresh authorized room read plus the social invalidation revision. */
const refresh = (api: Awaited<ReturnType<typeof service>>['api'], actor: RoomActor) => async () => {
    await api.currentRoom(actor);
    await db().collection('socialOutbox').findOne({ _id: actor.userId as never }, { projection: { revision: 1 } });
};

test('an idle sweep costs one read, and each steady room adds about two reads per member', async () => {
    const { api, epoch } = await service();
    const idle = await perCall(20, () => api.sweep());
    assert.ok(idle <= 1.2, `idle sweep used ${idle} operations`);
    const costs: Record<string, number> = {};
    for (const members of [1, 4, 8]) {
        for (const playing of [false, true]) {
            await db().collection('socialRooms').deleteMany({});
            await openRoom(members, epoch, playing);
            await api.sweep();
            const measured = await perCall(10, () => api.sweep()) - idle;
            costs[`${members}${playing ? 'p' : ''}`] = measured;
            // Room read, two lease inspections, two transaction aborts, per-member account and session reads,
            // plus the current media while playing: 2M + 5, plus one while playing.
            assert.ok(measured <= 2 * members + 5 + (playing ? 1 : 0) + 0.5, `${members}-member ${playing ? 'playing' : 'paused'} room used ${measured} operations per sweep`);
        }
    }
    assert.ok(costs['8'] > costs['1'], 'larger rooms must cost more; otherwise the measurement is not observing the sweep');
});

test('a connected socket refresh costs at most five operations idle and eight in a room', async () => {
    const { api, epoch } = await service();
    const idle = await listener();
    const idleCost = await perCall(10, refresh(api, idle.actor));
    assert.ok(idleCost <= 5.5, `idle refresh used ${idleCost} operations`);
    const { people } = await openRoom(4, epoch, false);
    const memberCost = await perCall(10, refresh(api, people[1].actor));
    assert.ok(memberCost <= 8.5, `member refresh used ${memberCost} operations`);
    assert.ok(memberCost > idleCost);
});

test('a steady controller heartbeat costs the member count plus six operations', async () => {
    const { api, epoch } = await service();
    for (const members of [2, 4, 8]) {
        await db().collection('socialRooms').deleteMany({});
        await db().collection('socialRoomParticipation').deleteMany({});
        const { room, people } = await openRoom(members, epoch, false);
        const report = { roomId: room._id, memberId: people[0].member.membershipId, controllerGeneration: 1, locallyPaused: false };
        await api.heartbeat(people[0].actor, report);
        const measured = await perCall(10, () => api.heartbeat(people[0].actor, report));
        assert.ok(measured <= members + 6.5, `${members}-member heartbeat used ${measured} operations`);
    }
});
