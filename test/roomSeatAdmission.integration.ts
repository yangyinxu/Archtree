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
import type { RoomCommand, RoomSnapshot } from '../src/contracts/roomV1';
import type { SocialScope, SocialOutcome } from '../src/contracts/socialV1';
import { roomAuthority } from '../src/realtime/roomAuthority';
import { installRoomGateway } from '../src/realtime/roomGateway';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav, wavUploadFile } from './support/pcmWav';

/**
 * The shipped deployment capacity end to end: real tickets, the real gateway and real room commands. One open
 * room of two members and ten sockets leaves eight general seats and two reserved for the room's members.
 */
let mongo: MongoReplicaSetHarness;
let storage: Awaited<ReturnType<typeof startLocalS3>>;
let server: Server;
let lifecycle: ServerLifecycle;
let gateway: ReturnType<typeof installRoomGateway>;
let base: string;
let mediaId: string;
const sockets: WebSocket[] = [];
const variables = ['FINITUDE_SOCIAL_ENABLED', 'FINITUDE_ROOMS_ENABLED', 'ALLOW_LEGACY_AUTH_TOKENS', 'AWS_ENDPOINT_URL_S3', 'AWS_REGION',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME', 'AWS_SESSION_TOKEN',
    'FINITUDE_ROOMS_MAX_OPEN', 'FINITUDE_ROOM_MAX_MEMBERS', 'FINITUDE_REALTIME_MAX_SOCKETS'];
const oldEnvironment = Object.fromEntries(variables.map(key => [key, process.env[key]]));

before(async () => {
    mongo = await startMongoReplicaSet('archtree-room-seat-admission-test');
    storage = await startLocalS3('room-seat-admission-media');
    Object.assign(process.env, { FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: 'true', ALLOW_LEGACY_AUTH_TOKENS: 'false',
        AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'owned-local-fixture',
        AWS_SECRET_ACCESS_KEY: 'owned-local-fixture-secret', S3_BUCKET_NAME: storage.bucket,
        FINITUDE_ROOMS_MAX_OPEN: '1', FINITUDE_ROOM_MAX_MEMBERS: '2', FINITUDE_REALTIME_MAX_SOCKETS: '10' });
    delete process.env.AWS_SESSION_TOKEN;
    const id = new ObjectId(); mediaId = id.toHexString();
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title: 'Synthetic seat melody', s3Key: mediaId, mediaType: 'audio',
        uploadStatus: 'pending', publicationStatus: 'ready', duration: '2:00' });
    await uploadAudioObject(mediaId, wavUploadFile(createPcmWav(120_000)), 'synthetic-uploader');
    lifecycle = new ServerLifecycle();
    server = createServer(createApp({ lifecycle, environment: 'test' }));
    await roomAuthority.acquire();
    gateway = installRoomGateway(server, lifecycle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
    for (const socket of sockets) socket.terminate();
    if (server) await lifecycle.stop(server, async () => {
        await gateway.release(); getS3().destroy(); await storage.stop(); await mongo.stop();
    }, 5_000, 10_000);
    for (const key of variables) {
        if (oldEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = oldEnvironment[key];
    }
});

const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const account = async () => {
    const id = new ObjectId();
    const user = { _id: id, email: `${id}@example.test`, role: 'user', password: 'unused-synthetic-hash', emailVerified: true };
    await getDb()!.collection('users').insertOne(user);
    const tokens = await createSession(user);
    const actor = { userId: id.toHexString(), sessionId: tokens.sessionId, clientId: randomUUID() };
    const social = createSocialService();
    const scope = await social.issueScope(actor);
    assert.equal((await social.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0,
        handle: `s${id.toHexString().slice(-20)}`, alias: 'Synthetic seat listener', discoverable: true })).outcome, 'applied');
    const profile = await social.ownProfile(actor); assert.ok(profile);
    return { ...actor, token: tokens.accessToken, scope, profile };
};
type Account = Awaited<ReturnType<typeof account>>;
const call = async (who: Account, path: string, body?: unknown, clientId = who.clientId) => {
    const response = await fetch(`${base}/api/social/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${who.token}`, 'X-Finitude-Room-Client': clientId,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() as Record<string, unknown> };
};
const submit = async (who: Account, body: Omit<RoomCommand, 'scopeToken' | 'commandId'> | Record<string, unknown>) => {
    const response = await call(who, '/room-commands', { ...identity(who.scope), ...body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as unknown as SocialOutcome;
};
const current = async (who: Account) => (await call(who, '/rooms/current')).body.room as RoomSnapshot | null;
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 6_000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
        if (Date.now() >= deadline) assert.fail('Timed out waiting for the gateway.');
        await new Promise(resolve => setTimeout(resolve, 30));
    }
};
/** One browser tab: its own client ID, a ticket request, and on success a subscribed socket. */
const tab = async (who: Account) => {
    const clientId = randomUUID();
    const ticket = await call(who, '/realtime-tickets', { clientId }, clientId);
    if (ticket.status !== 200) return { status: ticket.status, retryAfter: ticket.retryAfter, code: ticket.body.code };
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/social/v1/realtime', ['archtree-room-v1', String(ticket.body.ticket)], { origin: base });
    sockets.push(socket);
    const frames: Array<{ type: string; room?: RoomSnapshot | null }> = [];
    socket.on('message', data => { frames.push(JSON.parse(data.toString())); });
    socket.on('error', () => undefined);
    await waitFor(() => frames.some(frame => frame.type === 'subscribed'));
    return { status: 200, socket, frames, clientId };
};
const health = async () => (await (await fetch(`${base}/health`)).json() as { rooms: { openSockets: number } }).rooms.openSockets;
const busy = { status: 503, retryAfter: '30', code: 'realtime_capacity' };

test('with the general seats full, a creator and an invitee join over HTTP and then connect with reserved seats', async () => {
    const host = await account(); const guest = await account();
    const social = createSocialService();
    await social.mutate(host, { ...identity(host.scope), action: 'request', targetSocialId: guest.profile.socialId, expectedRevision: 0 });
    const pair = await social.relationship(guest, host.profile.socialId); assert.ok(pair);
    await social.mutate(guest, { ...identity(guest.scope), action: 'accept', targetSocialId: host.profile.socialId, expectedRevision: pair.revision });

    // Four listeners outside any room open two tabs each and fill the eight general seats.
    const idle = [await account(), await account(), await account(), await account()];
    for (const who of idle) for (let index = 0; index < 2; index += 1) assert.equal((await tab(who)).status, 200);
    assert.equal(await health(), 8);
    assert.deepEqual(await tab(idle[0]), busy, 'A third tab exceeds the per-account share.');
    assert.deepEqual(await tab(await account()), busy, 'Another listener waits for a general seat.');
    assert.deepEqual(await tab(host), busy, 'Outside a room the host has no reserved seat yet.');

    // Creating needs no live connection; once the host is a member a reserved seat is available.
    assert.equal((await submit(host, { action: 'create', mediaTrackIds: [mediaId] })).outcome, 'applied');
    const hostTab = await tab(host);
    assert.equal(hostTab.status, 200);
    assert.ok(hostTab.frames?.find(frame => frame.type === 'subscribed')?.room, 'The host\'s socket subscribes to the new room.');
    assert.deepEqual(await tab(host), busy, 'A member\'s second tab needs a general seat.');
    const room = (await current(host))!;
    assert.equal((await submit(host, { action: 'invite', roomId: room.roomId, memberId: room.self.memberId,
        targetSocialId: guest.profile.socialId })).outcome, 'applied');

    // The invitee is refused a socket, accepts over HTTP, and then takes the second reserved seat.
    assert.deepEqual(await tab(guest), busy);
    const invitation = (await call(guest, '/room-invitations')).body.invitations as Array<{ invitationId: string; generation: number }>;
    assert.equal(invitation.length, 1);
    assert.equal((await submit(guest, { action: 'acceptInvitation', invitationId: invitation[0].invitationId,
        generation: invitation[0].generation })).outcome, 'applied');
    const guestTab = await tab(guest);
    assert.equal(guestTab.status, 200);
    assert.equal(guestTab.frames?.find(frame => frame.type === 'subscribed')?.room?.roomId, room.roomId);
    assert.equal(await health(), 10);
    assert.deepEqual(await tab(await account()), busy, 'The process is full.');

    // An idle tab closing frees a general seat for the next listener.
    sockets[0].close(1000);
    await waitFor(async () => await health() === 9);
    assert.equal((await tab(await account())).status, 200);
});

test('concurrent creates by different listeners admit no more rooms than the open-room limit', async () => {
    const creators = [await account(), await account(), await account()];
    // The previous case's room is still open; expire it so the sweep frees the limit of one.
    const rooms = getDb()!.collection<{ _id: string; state: string; expiresAt: Date }>('socialRooms');
    assert.equal(await rooms.countDocuments({ state: 'open' }), 1);
    await rooms.updateOne({ state: 'open' }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await waitFor(async () => await rooms.countDocuments({ state: 'open' }) === 0);

    const outcomes = await Promise.all(creators.map(who => submit(who, { action: 'create', mediaTrackIds: [mediaId] })));
    assert.deepEqual(outcomes.map(value => value.outcome).sort(), ['applied', 'rejected', 'rejected']);
    assert.deepEqual(outcomes.filter(value => value.outcome === 'rejected').map(value => value.code), ['room_capacity', 'room_capacity']);
    assert.equal(await rooms.countDocuments({ state: 'open' }), 1);
});
