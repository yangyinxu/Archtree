import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId, type ClientSession } from 'mongodb';
import { createRoomService, type RoomServiceOptions } from '../src/application/rooms/roomService';
import { createSocialService } from '../src/application/social/socialService';
import { ROOM_LIMITS, type RoomActor, type RoomApi, type RoomCommand, type RoomMediaDescriptor, type RoomSnapshot } from '../src/contracts/roomV1';
import { SOCIAL_LIMITS, SocialError, type SocialApi, type SocialScope } from '../src/contracts/socialV1';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import { createRoomAuthority } from '../src/realtime/roomAuthority';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';
import { installRoomWindDown } from '../src/realtime/roomWindDown';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let now = Date.now();
let social: SocialApi;
let media: RoomMediaDescriptor[];
const secret = 'synthetic-room-wind-down-secret';
const collections = ['users', 'authSessions', 'socialProfiles', 'socialRelationships', 'socialMutations', 'socialOutbox', 'socialBudgets',
    'socialHandles', 'socialRooms', 'socialRoomParticipation', 'socialRoomOutbox', 'socialInvitations', 'audioTracks', 'socialAuthority',
    'socialListeningStates', 'socialListeningPublications'];
const database = () => getDb()!;
const flags = { social: process.env.FINITUDE_SOCIAL_ENABLED, rooms: process.env.FINITUDE_ROOMS_ENABLED };

/** Synthetic media still uses the actual source document as a transactional replacement fence. */
const resolveMedia = async (id: string, session?: ClientSession) => {
    const value = await database().collection('audioTracks').findOne({ _id: new ObjectId(id), uploadStatus: 'ready', publicationStatus: 'ready' }, { session });
    return value?.roomFixture as RoomMediaDescriptor | undefined ?? null;
};
const touchMedia = async (id: string, revision: string, session: ClientSession) => {
    const value = await database().collection('audioTracks').findOneAndUpdate({ _id: new ObjectId(id), uploadStatus: 'ready',
        publicationStatus: 'ready', 'roomFixture.mediaRevision': revision }, { $inc: { roomFence: 1 } }, { session, returnDocument: 'after' });
    return value.value?.roomFixture as RoomMediaDescriptor | undefined ?? null;
};
/** Each simulated process owns a real MongoDB lease, exactly like the production singleton. */
const processRooms = (authority: ReturnType<typeof createRoomAuthority>, enabled: boolean, options: RoomServiceOptions = {}) => createRoomService({
    now: () => now, enabled: () => enabled, secret: () => secret, resolveMedia, touchMedia,
    assertAuthority: session => authority.assert(session), inspectAuthority: session => authority.inspect(session), ...options });

before(async () => { harness = await startMongoReplicaSet('archtree-room-wind-down-test'); });
beforeEach(async () => {
    now = Date.now();
    await Promise.all(collections.map(name => database().collection(name).deleteMany({})));
    media = Array.from({ length: 2 }, (_, index) => {
        const mediaTrackId = new ObjectId().toHexString();
        return { mediaTrackId, title: `Wind-down audio ${index}`, mediaRevision: `mr_${String(index + 1).repeat(32)}`, durationMs: 60_000,
            streamUrl: `/content/mediaTrack/stream/${mediaTrackId}?revision=mr_${String(index + 1).repeat(32)}`, mediaType: 'Audio' as const };
    });
    await database().collection('audioTracks').insertMany(media.map(roomFixture => ({ _id: new ObjectId(roomFixture.mediaTrackId),
        uploadStatus: 'ready', publicationStatus: 'ready', s3Key: roomFixture.mediaTrackId,
        mediaRepresentation: { seekable: true, format: 'wav-pcm' }, roomFixture })));
    social = createSocialService({ now: () => now, enabled: () => true, secret: () => secret });
});
after(async () => {
    await harness?.stop();
    for (const [key, value] of [['FINITUDE_SOCIAL_ENABLED', flags.social], ['FINITUDE_ROOMS_ENABLED', flags.rooms]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const person = async (name: string, target = social) => {
    const user = new ObjectId();
    await database().collection('users').insertOne({ _id: user, email: `${name}@private.invalid`, username: `private-${name}`, role: 'user' });
    const sessionId = await AuthSession.create(user.toHexString(), `synthetic-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs * 7));
    const actor: RoomActor = { userId: user.toHexString(), sessionId, clientId: randomUUID() };
    const scope = await target.issueScope(actor);
    assert.equal((await target.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0, handle: name,
        alias: `Public ${name}`, discoverable: true })).outcome, 'applied');
    return { actor, scope, profile: (await target.ownProfile(actor))! };
};
type Person = Awaited<ReturnType<typeof person>>;
const command = (who: Person, body: Record<string, unknown>) => ({ ...body, ...identity(who.scope) }) as RoomCommand;
const memberBody = (state: RoomSnapshot) => ({ roomId: state.roomId, memberId: state.self.memberId });
const control = (who: Person, state: RoomSnapshot, action: string) => command(who, { ...memberBody(state), action, expectedEpoch: state.epoch,
    controllerGeneration: state.self.controllerGeneration, expectedControlGeneration: state.controlGeneration,
    expectedPlaybackGeneration: state.timeline!.playbackGeneration, expectedEntryId: state.timeline!.entryId, expectedQueueRevision: state.queueRevision });
const heartbeat = (rooms: RoomApi, who: Person, state: RoomSnapshot) => rooms.heartbeat(who.actor,
    { ...memberBody(state), controllerGeneration: state.self.controllerGeneration, locallyPaused: false });
const current = async (rooms: RoomApi, who: Person) => { const value = await rooms.currentRoom(who.actor); assert.ok(value); return value; };
const friends = async (a: Person, b: Person) => {
    assert.equal((await social.mutate(a.actor, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId, expectedRevision: 0 })).outcome, 'applied');
    const relation = await social.relationship(b.actor, a.profile.socialId);
    assert.equal((await social.mutate(b.actor, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId, expectedRevision: relation!.revision })).outcome, 'applied');
};

/** An earlier, rooms-enabled process leaves a two-member room actually playing. */
const playingRoom = async (rooms: RoomApi) => {
    const host = await person('hostess'); const guest = await person('guestly'); await friends(host, guest);
    assert.equal((await rooms.mutate(host.actor, command(host, { action: 'create', mediaTrackIds: media.map(value => value.mediaTrackId) }))).outcome, 'applied');
    await heartbeat(rooms, host, await current(rooms, host));
    assert.equal((await rooms.mutate(host.actor, command(host, { action: 'invite', ...memberBody(await current(rooms, host)), targetSocialId: guest.profile.socialId }))).outcome, 'applied');
    const invitation = (await rooms.invitations(guest.actor))[0]; assert.ok(invitation);
    assert.equal((await rooms.mutate(guest.actor, command(guest, { action: 'acceptInvitation', invitationId: invitation.invitationId, generation: invitation.generation }))).outcome, 'applied');
    await heartbeat(rooms, guest, await current(rooms, guest));
    assert.equal((await rooms.mutate(host.actor, control(host, await current(rooms, host), 'play'))).outcome, 'applied');
    for (const who of [host, guest]) {
        const state = await current(rooms, who);
        await rooms.ready(who.actor, { ...memberBody(state), controllerGeneration: state.self.controllerGeneration, expectedEpoch: state.epoch,
            preparationId: state.preparation!.preparationId, playbackGeneration: state.timeline!.playbackGeneration,
            entryId: state.timeline!.entryId, mediaRevision: state.timeline!.mediaRevision, sequence: 1, ready: true });
    }
    const state = await current(rooms, host);
    assert.equal(state.timeline?.state, 'playing');
    return { host, guest, roomId: state.roomId };
};

/** Installs the disabled-process wind-down on a fast schedule against the real sweep and lease. */
const windDown = (authority: ReturnType<typeof createRoomAuthority>) => {
    const logs: string[] = [];
    const metrics = createRoomGatewayMetrics(Date.now, () => false);
    const server = createServer();
    const runtime = installRoomWindDown(server, new ServerLifecycle(), { api: processRooms(authority, false), metrics, intervalMs: 20,
        acquire: () => authority.acquire(), release: () => authority.release(), log: entry => logs.push(entry.state) });
    return { logs, metrics, runtime };
};
const eventually = async (condition: () => Promise<boolean> | boolean, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!await condition()) {
        if (Date.now() > deadline) assert.fail(`Wind-down integration deadline exceeded: ${label}.`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
const roomState = (roomId: string) => database().collection('socialRooms').findOne({ _id: roomId as never });

test('a process started with rooms off pauses, suspends and then ends rooms left open, and releases the authority', async () => {
    const previous = createRoomAuthority(`previous-${randomUUID()}`);
    assert.ok(await previous.acquire());
    const { host, guest, roomId } = await playingRoom(processRooms(previous, true));
    // A graceful shutdown of the enabled process releases its lease; the next process starts with rooms off.
    await previous.release();
    const disabled = createRoomAuthority(`disabled-${randomUUID()}`);
    const reader = processRooms(disabled, false);
    const run = windDown(disabled);
    try {
        await eventually(async () => (await reader.currentRoom(host.actor))?.timeline?.state === 'paused', 'shared pause');
        assert.equal((await current(reader, host)).status, 'open');
        assert.equal(run.metrics.snapshot().authorityState, 'windingDown');
        assert.deepEqual(run.logs, ['started']);
        // No playback can restart while rooms are off, but the existing safety exits keep working.
        await assert.rejects(reader.mutate(host.actor, control(host, await current(reader, host), 'play')),
            (error: unknown) => error instanceof SocialError && error.code === 'rooms_disabled');

        now += ROOM_LIMITS.hostGraceMs;
        await eventually(async () => (await reader.currentRoom(host.actor))?.status === 'suspended', 'host-absence suspension');
        assert.equal((await reader.mutate(guest.actor, command(guest, { action: 'leave', ...memberBody(await current(reader, guest)) }))).outcome, 'applied');
        assert.equal(run.logs.includes('complete'), false);

        now += ROOM_LIMITS.hostCloseMs;
        await eventually(() => run.logs.includes('complete'), 'host-absence end');
        assert.equal(await reader.currentRoom(host.actor), null);
        assert.equal(await reader.currentRoom(guest.actor), null);
        assert.equal((await roomState(roomId))?.state, 'closed');
        assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 0);
        assert.equal(run.metrics.snapshot().authorityState, 'inactive');
        assert.deepEqual(run.metrics.snapshot().failures, { authorityAcquisition: 0, sweep: 0, refresh: 0, report: 0, disconnect: 0 });
        // The released lease is immediately available to a later rooms-enabled process.
        assert.equal((await database().collection('socialAuthority').findOne({ _id: 'rooms-v1' as never }))?.expiresAt.getTime(), 0);
        assert.deepEqual(run.logs, ['started', 'complete']);
    } finally { run.runtime.stop(); await run.runtime.release(); }
});

test('with no open room the disabled process completes at once and never writes the room authority', async () => {
    const run = windDown(createRoomAuthority(`disabled-${randomUUID()}`));
    try {
        await eventually(() => run.logs.includes('complete'), 'completion');
        assert.deepEqual(run.logs, ['complete']);
        assert.equal(run.metrics.snapshot().authorityState, 'inactive');
        assert.equal(await database().collection('socialAuthority').countDocuments({}), 0);
    } finally { run.runtime.stop(); }
});

test('a lease still held by the previous process defers the wind-down without any unfenced room write', async () => {
    const previous = createRoomAuthority(`previous-${randomUUID()}`);
    assert.ok(await previous.acquire());
    const enabled = processRooms(previous, true);
    const { host, roomId } = await playingRoom(enabled);
    const revision = (await roomState(roomId))?.revision;
    const disabled = createRoomAuthority(`disabled-${randomUUID()}`);
    const run = windDown(disabled);
    try {
        await eventually(() => run.metrics.snapshot().failures.authorityAcquisition >= 2, 'refused acquisition');
        assert.equal(run.metrics.snapshot().authorityState, 'unavailable');
        assert.equal((await roomState(roomId))?.revision, revision);
        assert.equal((await current(enabled, host)).timeline?.state, 'playing');

        await previous.release();
        const reader = processRooms(disabled, false);
        await eventually(async () => (await reader.currentRoom(host.actor))?.timeline?.state === 'paused', 'pause after takeover');
        // A host may end the room at once instead of waiting for the absence rules.
        assert.equal((await reader.mutate(host.actor, command(host, { action: 'end', ...memberBody(await current(reader, host)) }))).outcome, 'applied');
        await eventually(() => run.logs.includes('complete'), 'completion after End');
        assert.equal(run.metrics.snapshot().authorityState, 'inactive');
    } finally { run.runtime.stop(); await run.runtime.release(); }
});

test('switching off only rooms keeps friendships and listening sharing while refusing new rooms', async () => {
    process.env.FINITUDE_SOCIAL_ENABLED = 'true'; process.env.FINITUDE_ROOMS_ENABLED = 'false';
    // Both services read the real rollout flags, as the production routes do.
    const flagged = createSocialService({ now: () => now, secret: () => secret });
    const rooms = createRoomService({ now: () => now, secret: () => secret, resolveMedia, touchMedia });
    const a = await person('alpha', flagged); const b = await person('bravo', flagged);
    assert.equal((await flagged.mutate(a.actor, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId, expectedRevision: 0 })).outcome, 'applied');
    const relation = await flagged.relationship(b.actor, a.profile.socialId);
    assert.equal((await flagged.mutate(b.actor, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId,
        expectedRevision: relation!.revision })).outcome, 'applied');
    assert.equal((await flagged.mutate(a.actor, { ...identity(a.scope), action: 'setListeningSharing', enabled: true,
        expectedRevision: (await flagged.ownListening(a.actor)).revision })).outcome, 'applied');
    assert.equal((await flagged.ownListening(a.actor)).enabled, true);
    await assert.rejects(rooms.mutate(a.actor, command(a, { action: 'create', mediaTrackIds: [media[0].mediaTrackId] })),
        (error: unknown) => error instanceof SocialError && error.statusCode === 503 && error.code === 'rooms_disabled');
    assert.equal(await database().collection('socialRooms').countDocuments({}), 0);
});
