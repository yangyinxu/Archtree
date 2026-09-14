import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { getS3 } from '../src/infrastructure/s3';
import { createSession } from '../src/services/authSessionService';
import { uploadAudioObject } from '../src/services/audioStorageService';
import { createSocialService } from '../src/application/social/socialService';
import { createRoomService } from '../src/application/rooms/roomService';
import type { RoomCommand, RoomCommunity, RoomInvitation, RoomOutgoingInvitation, RoomSnapshot } from '../src/contracts/roomV1';
import type { SocialScope, SocialOutcome } from '../src/contracts/socialV1';
import { roomAuthority } from '../src/realtime/roomAuthority';
import { installRoomGateway } from '../src/realtime/roomGateway';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import AuthSession from '../src/models/authSession';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav, wavUploadFile } from './support/pcmWav';

let mongo: MongoReplicaSetHarness;
let storage: Awaited<ReturnType<typeof startLocalS3>>;
let server: Server;
let lifecycle: ServerLifecycle;
let gateway: ReturnType<typeof installRoomGateway>;
let base: string;
const mediaIds: string[] = [];
const sockets: WebSocket[] = [];
const gatewayReads = new Map<string, number>();
const oldEnvironment = { ...process.env };

before(async () => {
    mongo = await startMongoReplicaSet('archtree-room-realtime-test');
    storage = await startLocalS3('room-realtime-media');
    Object.assign(process.env, { FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: 'true', ALLOW_LEGACY_AUTH_TOKENS: 'false',
        AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'owned-local-fixture',
        AWS_SECRET_ACCESS_KEY: 'owned-local-fixture-secret', S3_BUCKET_NAME: storage.bucket });
    delete process.env.AWS_SESSION_TOKEN;
    for (const title of ['First synthetic melody', 'Second synthetic melody', 'Third synthetic melody']) {
        const id = new ObjectId(); mediaIds.push(id.toHexString());
        await getDb()!.collection('audioTracks').insertOne({ _id: id, title, s3Key: id.toHexString(), mediaType: 'audio',
            uploadStatus: 'pending', publicationStatus: 'ready', duration: '2:00' });
        await uploadAudioObject(id.toHexString(), wavUploadFile(createPcmWav(120_000)), 'synthetic-uploader');
    }
    lifecycle = new ServerLifecycle();
    server = createServer(createApp({ lifecycle, environment: 'test' }));
    await roomAuthority.acquire();
    const roomApi = createRoomService();
    gateway = installRoomGateway(server, lifecycle, { api: { ...roomApi, currentRoom: async actor => {
        gatewayReads.set(actor.userId, (gatewayReads.get(actor.userId) ?? 0) + 1);
        return roomApi.currentRoom(actor);
    } } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
    for (const socket of sockets) socket.terminate();
    if (server) await lifecycle.stop(server, async () => {
        await gateway.release(); getS3().destroy(); await storage.stop(); await mongo.stop();
    }, 5_000, 10_000);
    for (const key of ['FINITUDE_SOCIAL_ENABLED', 'FINITUDE_ROOMS_ENABLED', 'ALLOW_LEGACY_AUTH_TOKENS',
        'AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME', 'AWS_SESSION_TOKEN']) {
        if (oldEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = oldEnvironment[key];
    }
});

const account = async () => {
    const id = new ObjectId();
    const user = { _id: id, email: `${id}@example.test`, role: 'user', password: 'unused-synthetic-hash' };
    await getDb()!.collection('users').insertOne(user);
    const tokens = await createSession(user);
    const actor = { userId: id.toHexString(), sessionId: tokens.sessionId, clientId: randomUUID() };
    const social = createSocialService();
    const scope = await social.issueScope(actor);
    const profileOutcome = await social.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0,
        handle: `u${id.toHexString().slice(-20)}`, alias: 'Synthetic listener', discoverable: true });
    assert.equal(profileOutcome.outcome, 'applied');
    const profile = await social.ownProfile(actor); assert.ok(profile);
    return { ...actor, token: tokens.accessToken, scope, profile };
};
type Account = Awaited<ReturnType<typeof account>>;
const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const request = async <T>(who: Account, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}/api/social/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${who.token}`, 'X-Finitude-Room-Client': who.clientId,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
};
const current = async (who: Account) => (await request<{ room: RoomSnapshot | null }>(who, '/rooms/current')).room;
const submit = (who: Account, body: Omit<RoomCommand, 'scopeToken' | 'commandId'> | Record<string, unknown>) =>
    request<SocialOutcome>(who, '/room-commands', { ...identity(who.scope), ...body });
const observed = (room: RoomSnapshot) => ({ roomId: room.roomId, memberId: room.self.memberId,
    expectedEpoch: room.epoch, controllerGeneration: room.self.controllerGeneration,
    expectedControlGeneration: room.controlGeneration, expectedPlaybackGeneration: room.timeline!.playbackGeneration,
    expectedQueueRevision: room.queueRevision, expectedEntryId: room.timeline!.entryId });
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 6_000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
        if (Date.now() >= deadline) assert.fail('Timed out waiting for the real room transition.');
        await new Promise(resolve => setTimeout(resolve, 30));
    }
};
const connect = async (who: Account) => {
    const { ticket } = await request<{ ticket: string }>(who, '/realtime-tickets', { clientId: who.clientId });
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/social/v1/realtime', ['archtree-room-v1', ticket], { origin: base });
    sockets.push(socket);
    const frames: Array<{ type: string; room?: RoomSnapshot | null; serverTimeMs?: number }> = [];
    socket.on('message', data => { frames.push(JSON.parse(data.toString())); });
    socket.on('error', () => undefined);
    await waitFor(() => frames.some(frame => frame.type === 'subscribed'));
    const heartbeat = (room: RoomSnapshot, locallyPaused = false) => socket.send(JSON.stringify({ type: 'ping', clientTimeMs: 1,
        heartbeat: { roomId: room.roomId, memberId: room.self.memberId, controllerGeneration: room.self.controllerGeneration, locallyPaused } }));
    return { socket, frames, ticket, heartbeat };
};
const friends = async (a: Account, b: Account) => {
    const social = createSocialService();
    await social.mutate(a, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId, expectedRevision: 0 });
    const pair = await social.relationship(b, a.profile.socialId); assert.ok(pair);
    await social.mutate(b, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId, expectedRevision: pair.revision });
};
const joinedPair = async () => {
    const a = await account(); const b = await account(); await friends(a, b);
    const sa = await connect(a); const sb = await connect(b);
    assert.equal((await submit(a, { action: 'create', mediaTrackIds: mediaIds })).outcome, 'applied');
    const room = (await current(a))!; sa.heartbeat(room);
    await waitFor(async () => (await current(a))!.members.find(member => member.memberId === room.self.memberId)!.connected);
    assert.equal((await submit(a, { action: 'invite', roomId: room.roomId, memberId: room.self.memberId,
        targetSocialId: b.profile.socialId })).outcome, 'applied');
    const invitation = (await request<{ invitations: Array<{ invitationId: string; generation: number }> }>(b, '/room-invitations')).invitations[0];
    assert.ok(invitation);
    assert.equal((await submit(b, { action: 'acceptInvitation', invitationId: invitation.invitationId, generation: invitation.generation })).outcome, 'applied');
    sb.heartbeat((await current(b))!);
    await waitFor(async () => (await current(b))!.members.every(member => member.connected));
    return { a, b, sa, sb };
};

test('real invitation HTTP reads enforce recipient, current controller, viewer and strict route boundaries', async () => {
    const host = await account(); const guest = await account(); const outsider = await account(); await friends(host, guest);
    await submit(host, { action: 'create', mediaTrackIds: mediaIds });
    const room = (await current(host))!;
    await submit(host, { action: 'invite', roomId: room.roomId, memberId: room.self.memberId, targetSocialId: guest.profile.socialId });
    const outgoing = (await request<{ invitations: RoomOutgoingInvitation[] }>(host, `/rooms/${room.roomId}/invitations`)).invitations;
    assert.equal(outgoing.length, 1); assert.equal(outgoing[0].recipientSocialId, guest.profile.socialId);
    assert.deepEqual(Object.keys(outgoing[0]).sort(), ['expiresAtMs', 'generation', 'invitationId', 'recipientSocialId']);
    const path = `/room-invitations/${outgoing[0].invitationId}`;
    const value = (await request<{ invitation: RoomInvitation | null }>(guest, path)).invitation; assert.ok(value);
    assert.deepEqual(Object.keys(value).sort(), ['expiresAtMs', 'generation', 'invitationId', 'inviter']);
    assert.equal((await request<{ invitation: RoomInvitation | null }>(host, path)).invitation, null);
    assert.equal((await request<{ invitation: RoomInvitation | null }>(outsider, path)).invitation, null);
    assert.equal(await current(guest), null, 'Reading a link must not admit the recipient.');
    const raw = (who: Account | null, target: string, headers: Record<string, string> = {}) => fetch(`${base}/api/social/v1${target}`, {
        headers: { ...(who ? { Authorization: `Bearer ${who.token}`, 'X-Finitude-Room-Client': who.clientId } : {}), ...headers }
    });
    assert.equal((await raw(null, path)).status, 401);
    const browserHeaders = { Cookie: `session_token=${guest.token}`, 'X-Finitude-Room-Client': guest.clientId,
        'X-Finitude-Account-Viewer': guest.userId };
    assert.equal((await raw(null, path, { ...browserHeaders, 'X-Finitude-Account-Viewer': outsider.userId })).status, 409);
    assert.equal((await raw(guest, path, { 'X-Finitude-Room-Client': 'short' })).status, 400);
    for (const suffix of ['?unknown=1', '?generation=1&generation=2']) assert.equal((await raw(guest, path + suffix)).status, 400);
    assert.equal((await raw(guest, '/room-invitations/invalid%20id')).status, 400);
    assert.equal((await raw(host, `/rooms/${room.roomId}/invitations`, { 'X-Finitude-Room-Client': randomUUID() })).status, 403);
    assert.equal((await raw(guest, `/rooms/${room.roomId}/invitations`)).status, 404);
    const privateResponse = await raw(null, path, browserHeaders);
    assert.ok(privateResponse.headers.get('cache-control')?.split(',').map(value => value.trim()).includes('no-store'));
    assert.ok(privateResponse.headers.get('vary')?.includes('X-Finitude-Account-Viewer'));
    assert.equal(privateResponse.headers.get('X-Finitude-Account-Viewer'), guest.userId);
    await submit(guest, { action: 'declineInvitation', invitationId: value.invitationId, generation: value.generation });
    assert.equal((await request<{ invitation: RoomInvitation | null }>(guest, path)).invitation, null);
    assert.deepEqual((await request<{ invitations: RoomOutgoingInvitation[] }>(host, `/rooms/${room.roomId}/invitations`)).invitations, []);
    await AuthSession.revokeById(guest.userId, guest.sessionId);
    assert.equal((await raw(guest, path)).status, 401);
});

test('real community HTTP protects membership and current viewer while community changes publish only room revisions', async () => {
    const { a: host, b: guest, sa, sb } = await joinedPair(); const outsider = await account();
    const room = (await current(host))!; const guestRoom = (await current(guest))!;
    const path = `/rooms/${room.roomId}/community`;
    const raw = (who: Account | null, target = path, headers: Record<string, string> = {}) => fetch(`${base}/api/social/v1${target}`, {
        headers: { ...(who ? { Authorization: `Bearer ${who.token}`, 'X-Finitude-Room-Client': who.clientId } : {}), ...headers }
    });
    assert.equal((await raw(null)).status, 401);
    const missing = await raw(outsider, '/rooms/missing/community'); const foreign = await raw(outsider);
    assert.equal(missing.status, 404); assert.equal(foreign.status, 404); assert.deepEqual(await missing.json(), await foreign.json());
    assert.equal((await raw(guest, '/rooms/invalid%20id/community')).status, 400);
    for (const suffix of ['?unknown=1', '?limit=1&limit=2']) assert.equal((await raw(guest, path + suffix)).status, 400);
    assert.equal((await raw(guest, path, { 'X-Finitude-Room-Client': 'short' })).status, 400);
    const browserHeaders = { Cookie: `session_token=${guest.token}`, 'X-Finitude-Room-Client': guest.clientId,
        'X-Finitude-Account-Viewer': guest.userId };
    assert.equal((await raw(null, path, { ...browserHeaders, 'X-Finitude-Account-Viewer': outsider.userId })).status, 409);
    const response = await raw(null, path, browserHeaders);
    assert.equal(response.status, 200); assert.equal(response.headers.get('X-Finitude-Account-Viewer'), guest.userId);
    assert.ok(response.headers.get('cache-control')?.includes('no-store')); assert.ok(response.headers.get('vary')?.includes('X-Finitude-Account-Viewer'));
    const hostFrame = sa.frames.length; const guestFrame = sb.frames.length;
    const outboxes = await getDb()!.collection('socialOutbox').find({ _id: { $in: [host.userId, guest.userId] } }).sort({ _id: 1 }).toArray();
    const observer = { ...guest, clientId: randomUUID() };
    assert.equal((await submit(observer, { action: 'requestSong', roomId: room.roomId, memberId: guestRoom.self.memberId,
        expectedEpoch: room.epoch, mediaTrackId: mediaIds[1] })).outcome, 'applied');
    await waitFor(() => sa.frames.slice(hostFrame).some(frame => frame.type === 'snapshot' && (frame.room?.revision ?? 0) > room.revision)
        && sb.frames.slice(guestFrame).some(frame => frame.type === 'snapshot' && (frame.room?.revision ?? 0) > guestRoom.revision));
    const value = (await request<{ community: RoomCommunity }>(observer, path)).community;
    assert.equal(value.requests.length, 1); assert.equal(value.requests[0].requestedBy.socialId, guest.profile.socialId);
    assert.deepEqual(Object.keys(value).sort(), ['epoch', 'events', 'queueCredits', 'requests', 'revision', 'roomId']);
    assert.deepEqual(Object.keys(value.requests[0]).sort(), ['createdAtMs', 'mediaTrackId', 'requestId', 'requestedBy', 'title']);
    for (const who of [host, guest]) for (const privateId of [who.userId, who.sessionId, who.clientId]) assert.equal(JSON.stringify(value).includes(privateId), false);
    const unchanged = (await current(host))!;
    assert.deepEqual(unchanged.timeline, room.timeline); assert.deepEqual(unchanged.queue, room.queue);
    assert.equal('community' in unchanged, false);
    assert.deepEqual(Object.keys(unchanged.queue[0]).sort(), ['durationMs', 'entryId', 'mediaRevision', 'mediaTrackId', 'mediaType', 'streamUrl', 'title']);
    assert.equal((await submit(host, { ...observed(unchanged), action: 'acceptSongRequest', requestId: value.requests[0].requestId })).outcome, 'applied');
    const accepted = (await current(host))!;
    assert.equal(accepted.queue.length, room.queue.length + 1); assert.deepEqual(accepted.timeline, room.timeline);
    assert.equal((await submit(observer, { action: 'react', roomId: room.roomId, memberId: guestRoom.self.memberId,
        expectedEpoch: room.epoch, reaction: 'heart' })).outcome, 'applied');
    await waitFor(() => sa.frames.some(frame => frame.type === 'snapshot' && (frame.room?.revision ?? 0) > accepted.revision)
        && sb.frames.some(frame => frame.type === 'snapshot' && (frame.room?.revision ?? 0) > accepted.revision));
    const reacted = (await request<{ community: RoomCommunity }>(observer, path)).community;
    assert.equal(reacted.events.at(-1)?.reaction, 'heart'); assert.equal(reacted.events.at(-1)?.actor?.socialId, guest.profile.socialId);
    assert.deepEqual((await current(host))!.timeline, room.timeline);
    assert.deepEqual(await getDb()!.collection('socialOutbox').find({ _id: { $in: [host.userId, guest.userId] } }).sort({ _id: 1 }).toArray(), outboxes);
    await submit(host, { action: 'end', roomId: room.roomId, memberId: room.self.memberId });
    assert.equal((await raw(guest)).status, 404);
    await AuthSession.revokeById(guest.userId, guest.sessionId); assert.equal((await raw(guest)).status, 401);
});

test('real HTTP and WebSocket room flow protects host control and commits distinct concurrent Next only once', async () => {
    const { a, b, sa, sb } = await joinedPair();
    const initial = (await current(b))!;
    assert.equal((await submit(b, { ...observed(initial), action: 'next' })).outcome, 'rejected');
    assert.equal((await current(a))!.timeline!.entryId, initial.timeline!.entryId);
    assert.equal((await submit(a, { ...observed((await current(a))!), action: 'setControlMode', mode: 'everyone' })).outcome, 'applied');
    const ar = (await current(a))!; const br = (await current(b))!;
    const results = await Promise.all([submit(a, { ...observed(ar), action: 'next' }), submit(b, { ...observed(br), action: 'next' })]);
    assert.equal(results.filter(result => result.outcome === 'applied').length, 1);
    assert.equal(results.filter(result => result.outcome === 'rejected').length, 1);
    const advanced = (await current(a))!;
    assert.equal(advanced.timeline!.entryId, advanced.queue[1].entryId);
    assert.equal(advanced.timeline!.state, 'preparing');
    for (const [who, socket] of [[a, sa.socket], [b, sb.socket]] as const) {
        const room = (await current(who))!; const preparation = room.preparation!;
        socket.send(JSON.stringify({ type: 'ready', report: { roomId: room.roomId, memberId: room.self.memberId,
            controllerGeneration: room.self.controllerGeneration, expectedEpoch: room.epoch,
            preparationId: preparation.preparationId, playbackGeneration: preparation.playbackGeneration,
            entryId: preparation.entryId, mediaRevision: preparation.mediaRevision, sequence: 1, ready: true } }));
    }
    await waitFor(async () => (await current(a))!.timeline!.state === 'playing');
    await waitFor(() => [sa, sb].every(socket => socket.frames.some(frame => frame.type === 'snapshot' && frame.room?.timeline?.state === 'playing')));
    const outsider = await account();
    assert.equal((await request<{ room: unknown }>(outsider, `/rooms/${advanced.roomId}`)).room, null);
    const own = (await current(a))!;
    await submit(a, { action: 'end', roomId: own.roomId, memberId: own.self.memberId });
    await waitFor(() => sb.frames.some(frame => frame.type === 'snapshot' && frame.room === null));
    assert.equal(await current(b), null);
});

test('blocking and logout-all revoke actual room membership and close the authorized delivery path', async () => {
    const { a, b, sa, sb } = await joinedPair();
    await createSocialService().mutate(a, { ...identity(a.scope), action: 'block', targetSocialId: b.profile.socialId });
    assert.equal(await current(b), null);
    await waitFor(() => sb.frames.some(frame => frame.type === 'snapshot' && frame.room === null));
    await AuthSession.revokeAll(a.userId);
    await waitFor(() => sa.socket.readyState === WebSocket.CLOSED);
    assert.equal(await getDb()!.collection('socialRoomParticipation').countDocuments({ roomId: sa.frames.find(frame => frame.room)?.room?.roomId }), 0);
});

test('a consumed realtime ticket cannot be replayed and negotiation exposes only the protocol name', async () => {
    const user = await account(); const connected = await connect(user);
    const replay = new WebSocket(base.replace('http:', 'ws:') + '/api/social/v1/realtime', ['archtree-room-v1', connected.ticket], { origin: base });
    sockets.push(replay);
    const status = await new Promise<number>(resolve => {
        replay.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); });
        replay.on('error', () => undefined);
    });
    assert.equal(status, 401);
    replay.terminate();
    assert.equal(connected.socket.protocol, 'archtree-room-v1');
    assert.ok(connected.frames[0].serverTimeMs);
});

test('friend acceptance immediately invalidates both real subscribed social inboxes', async () => {
    const a = await account(); const b = await account();
    const sa = await connect(a); const sb = await connect(b);
    await waitFor(() => [sa, sb].every(value => value.frames.some(frame => frame.type === 'socialChanged')));
    const count = (value: typeof sa) => value.frames.filter(frame => frame.type === 'socialChanged').length;
    const before = [count(sa), count(sb)];
    await friends(a, b);
    await waitFor(() => count(sa) > before[0] && count(sb) > before[1]);
    assert.equal((await createSocialService().relationship(a, b.profile.socialId))?.state, 'friends');
});

test('unchanged heartbeats and duplicate readiness do not fan out fresh room reads; visible changes still do', async () => {
    const who = await account(); const connection = await connect(who);
    await submit(who, { action: 'create', mediaTrackIds: mediaIds });
    const room = (await current(who))!;
    connection.heartbeat(room);
    await waitFor(() => connection.frames.some(frame => frame.room?.members.some(member => member.memberId === room.self.memberId && member.connected)));
    // The next heartbeat must pass the real four-second admission interval. Then
    // align immediately after a recovery pass so its five-second cadence is excluded.
    await new Promise(resolve => setTimeout(resolve, 4_100));
    const beforeRecovery = gatewayReads.get(who.userId)!;
    await waitFor(() => gatewayReads.get(who.userId)! > beforeRecovery);
    await new Promise(resolve => setTimeout(resolve, 60));
    const baseline = gatewayReads.get(who.userId)!;
    const pongs = connection.frames.filter(frame => frame.type === 'pong').length;
    connection.heartbeat(room);
    await waitFor(() => connection.frames.filter(frame => frame.type === 'pong').length > pongs);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(gatewayReads.get(who.userId), baseline);

    const report = { roomId: room.roomId, memberId: room.self.memberId, controllerGeneration: room.self.controllerGeneration,
        expectedEpoch: room.epoch, preparationId: 'current', playbackGeneration: room.timeline!.playbackGeneration,
        entryId: room.timeline!.entryId, mediaRevision: room.timeline!.mediaRevision, sequence: 1, ready: true };
    connection.socket.send(JSON.stringify({ type: 'ready', report }));
    await waitFor(() => connection.frames.some(frame => frame.room?.members.some(member => member.memberId === room.self.memberId && member.ready)));
    assert.ok(gatewayReads.get(who.userId)! > baseline);
    await new Promise(resolve => setTimeout(resolve, 60));
    const beforeDuplicate = gatewayReads.get(who.userId)!;
    connection.socket.send(JSON.stringify({ type: 'ready', report }));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(gatewayReads.get(who.userId), beforeDuplicate);

    const changed = (await current(who))!;
    await submit(who, { action: 'end', roomId: changed.roomId, memberId: changed.self.memberId });
    await waitFor(() => connection.frames.some(frame => frame.type === 'snapshot' && frame.room === null));
});
