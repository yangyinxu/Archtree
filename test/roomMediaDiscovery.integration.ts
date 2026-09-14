import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app';
import { createRoomService } from '../src/application/rooms/roomService';
import { createSocialService } from '../src/application/social/socialService';
import { signSocialToken } from '../src/application/social/socialTokens';
import { ROOM_MEDIA_DISCOVERY_LIMITS, type RoomActor, type RoomMediaDescriptor, type RoomMediaPage } from '../src/contracts/roomV1';
import { SocialError } from '../src/contracts/socialV1';
import { getDb } from '../src/infrastructure/database';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import { createSession } from '../src/services/authSessionService';
import { resolveRoomAudioRepresentation } from '../src/services/mediaRepresentationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
let server: Server;
let base = '';
let now = Date.now();
const secret = 'synthetic-room-media-search-secret';
const originalEnabled = process.env.FINITUDE_SOCIAL_ENABLED;
const db = () => getDb()!;
const service = () => createRoomService({ now: () => now, secret: () => secret });
const id = (index: number) => index.toString(16).padStart(24, '0');
const errorCode = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;

before(async () => {
    harness = await startMongoReplicaSet('archtree-room-media-discovery-test');
    process.env.FINITUDE_SOCIAL_ENABLED = 'true';
    server = await new Promise<Server>(resolve => {
        const value = createApp({ environment: 'test' }).listen(0, '127.0.0.1', () => resolve(value));
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api/social/v1`;
});
beforeEach(async () => {
    now = Date.now(); resetRateLimitWindowsForTests();
    for (const name of ['users', 'authSessions', 'socialProfiles', 'socialHandles', 'socialBudgets', 'socialMutations',
        'socialOutbox', 'audioTracks', 'socialRooms']) await db().collection(name).deleteMany({});
});
after(async () => {
    await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await harness?.stop();
    if (originalEnabled === undefined) delete process.env.FINITUDE_SOCIAL_ENABLED; else process.env.FINITUDE_SOCIAL_ENABLED = originalEnabled;
});

/** Synthetic ready records exercise the production resolver without S3 reads, inspection or audio playback. */
const media = (index: number, title = `Melody ${index}`) => ({ _id: new ObjectId(id(index)), title,
    s3Key: id(index), mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready',
    mediaRepresentation: { revision: `mr_${index.toString(16).padStart(32, '0')}`, objectKey: id(index), byteLength: 320_044,
        durationMs: 10_000, seekable: true, format: 'wav-pcm', etag: '"synthetic-etag"', versionId: null } });
const account = async (active = true) => {
    const _id = new ObjectId(), user = { _id, email: `${_id}@example.test`, role: 'user', password: 'synthetic-unused-password' };
    await db().collection('users').insertOne(user);
    const session = await createSession(user);
    const actor: RoomActor = { userId: _id.toHexString(), sessionId: session.sessionId, clientId: randomUUID() };
    if (active) {
        const social = createSocialService({ enabled: () => true }); const scope = await social.issueScope(actor);
        assert.equal((await social.mutate(actor, { scopeToken: scope.scopeToken, commandId: randomUUID(), action: 'profile',
            expectedRevision: 0, handle: `u${actor.userId.slice(-20)}`, alias: 'Music listener', discoverable: true })).outcome, 'applied');
    }
    return { actor, token: session.accessToken };
};
type Account = Awaited<ReturnType<typeof account>>;
const request = (who: Account | null, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    headers: { ...(who ? { Authorization: `Bearer ${who.token}`, 'X-Finitude-Room-Client': who.actor.clientId } : {}), ...headers }
});
const json = async <T>(response: Response): Promise<T> => { assert.equal(response.status, 200); return response.json() as Promise<T>; };

test('room media search reaches every older eligible page without duplicate or skipped entries', async () => {
    const who = await account(), api = service();
    await db().collection('audioTracks').insertMany(Array.from({ length: 125 }, (_, index) => media(index + 1)));
    assert.deepEqual((await api.eligibleMedia(who.actor)).map(value => value.mediaTrackId), Array.from({ length: 50 }, (_, index) => id(125 - index)));
    const seen: string[] = [];
    let page = await api.searchMedia(who.actor, {});
    assert.equal(page.items.length, 20);
    seen.push(...page.items.map(value => value.mediaTrackId));
    await db().collection('audioTracks').insertOne(media(126));
    while (page.nextCursor) {
        page = await api.searchMedia(who.actor, { cursor: page.nextCursor });
        seen.push(...page.items.map(value => value.mediaTrackId));
    }
    assert.deepEqual(seen, Array.from({ length: 125 }, (_, index) => id(125 - index)));
    assert.equal((await api.searchMedia(who.actor, { limit: 50 })).items.length, 50);
    assert.equal((await api.mediaTrack(who.actor, id(1)))?.mediaTrackId, id(1));
});

test('room media search treats title text literally and binds cursors to account, query and logical expiry', async () => {
    const who = await account(), other = await account(), api = service();
    await db().collection('audioTracks').insertMany([media(1, 'Quiet [A].*'), media(2, 'QUIET [A].*'), media(3, 'Quiet ABC')]);
    const first = await api.searchMedia(who.actor, { query: '  [A].*  ', limit: 1 });
    assert.equal(first.items[0].mediaTrackId, id(2)); assert.ok(first.nextCursor);
    assert.deepEqual((await api.searchMedia(who.actor, { query: '[A].*', cursor: first.nextCursor })).items.map(value => value.mediaTrackId), [id(1)]);
    assert.equal((await api.searchMedia(who.actor, { query: 'quiet' })).items.length, 3);
    await assert.rejects(api.searchMedia(other.actor, { query: '[A].*', cursor: first.nextCursor }), errorCode('cursor_invalid'));
    await assert.rejects(api.searchMedia(who.actor, { query: 'Quiet', cursor: first.nextCursor }), errorCode('cursor_invalid'));
    await assert.rejects(api.searchMedia(who.actor, { query: '[A].*', cursor: first.nextCursor + 'a' }), errorCode('cursor_invalid'));
    const wrongAudience = signSocialToken({ audience: 'music-share-list-v1', accountId: who.actor.userId, direction: 'incoming',
        createdAt: now, id: 'ms_' + 'a'.repeat(32), expiresAt: now + 900_000 }, secret);
    await assert.rejects(api.searchMedia(who.actor, { cursor: wrongAudience }), errorCode('cursor_invalid'));
    now += ROOM_MEDIA_DISCOVERY_LIMITS.cursorMs;
    await assert.rejects(api.searchMedia(who.actor, { query: '[A].*', cursor: first.nextCursor }), errorCode('cursor_invalid'));
});

test('sparse room media pages stop at the candidate bound and retain a continuation past rejected representations', async () => {
    const who = await account(); let resolved = 0;
    const api = createRoomService({ now: () => now, secret: () => secret, resolveMedia: async (trackId, session) => {
        resolved++; return resolveRoomAudioRepresentation(trackId, session);
    } });
    await db().collection('audioTracks').insertMany(Array.from({ length: 203 }, (_, index) => {
        const value = media(index + 1); if (index >= 3) value.mediaRepresentation.etag = 'invalid'; return value;
    }));
    const before = await db().collection('audioTracks').find({}).sort({ _id: 1 }).toArray();
    const first = await api.searchMedia(who.actor, {});
    assert.deepEqual(first.items, []); assert.ok(first.nextCursor); assert.equal(resolved, 200);
    const next = await api.searchMedia(who.actor, { cursor: first.nextCursor });
    assert.deepEqual(next.items.map(value => value.mediaTrackId), [id(3), id(2), id(1)]); assert.equal(next.nextCursor, null);
    assert.deepEqual(await db().collection('audioTracks').find({}).sort({ _id: 1 }).toArray(), before);
    assert.equal(await db().collection('socialRooms').countDocuments({}), 0);
});

test('exact room media resolution hides every unavailable format and keeps only current public descriptor fields', async () => {
    const who = await account(), api = service();
    const rows = Array.from({ length: 6 }, (_, index) => media(index + 1));
    rows[1].mediaType = 'video'; rows[1].s3Key = `video/${id(2)}/${id(20)}`; rows[1].mediaRepresentation.objectKey = rows[1].s3Key;
    rows[2].uploadStatus = 'deleting'; rows[3].publicationStatus = 'pending';
    rows[4].mediaRepresentation.format = 'unsupported'; rows[5].mediaRepresentation.objectKey = 'private/mismatched-object';
    await db().collection('audioTracks').insertMany(rows);
    const found = await api.mediaTrack(who.actor, id(1)); assert.ok(found);
    assert.deepEqual(Object.keys(found).sort(), ['durationMs', 'mediaRevision', 'mediaTrackId', 'mediaType', 'streamUrl', 'title']);
    for (let index = 2; index <= 7; index++) assert.equal(await api.mediaTrack(who.actor, id(index)), null);
    assert.deepEqual((await api.searchMedia(who.actor, {})).items, [found]);
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(id(1)) }, { $set: { 'mediaRepresentation.revision': `mr_${'f'.repeat(32)}` } });
    assert.equal((await api.mediaTrack(who.actor, id(1)))?.mediaRevision, `mr_${'f'.repeat(32)}`);
});

test('room media discovery requires an active social profile and an unrevoked session', async () => {
    const who = await account(), inactive = await account(false), api = service();
    await db().collection('audioTracks').insertOne(media(1));
    for (const operation of [() => api.searchMedia(inactive.actor, {}), () => api.mediaTrack(inactive.actor, id(1))]) {
        await assert.rejects(operation(), errorCode('profile_unavailable'));
    }
    await db().collection('authSessions').updateOne({ _id: new ObjectId(who.actor.sessionId) }, { $set: { revokedAt: new Date() } });
    await assert.rejects(api.searchMedia(who.actor, {}), errorCode('social_session_required'));
    await assert.rejects(api.mediaTrack(who.actor, id(1)), errorCode('social_session_required'));
});

test('room media HTTP routes retain auth, viewer, strict query and legacy response boundaries', async () => {
    const who = await account(), inactive = await account(false);
    await db().collection('audioTracks').insertMany([media(1, 'Quiet + Water'), media(2, 'Other melody')]);
    const search = await json<RoomMediaPage>(await request(who, '/room-media/search?q=Quiet+%2B+Water&limit=1'));
    assert.deepEqual(search.items.map(value => value.mediaTrackId), [id(1)]); assert.equal(search.nextCursor, null);
    const exact = await request(who, `/room-media/${id(1)}`);
    assert.match(exact.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await json<{ item: RoomMediaDescriptor | null }>(exact)).item?.mediaTrackId, id(1));
    assert.deepEqual(await json(await request(who, `/room-media/${id(99)}`)), { item: null });
    assert.deepEqual(Object.keys(await json<Record<string, unknown>>(await request(who, '/room-media'))), ['items']);
    assert.equal((await request(null, '/room-media/search')).status, 401);
    assert.equal((await request(null, `/room-media/${id(1)}`)).status, 401);
    assert.equal((await request(inactive, '/room-media/search')).status, 404);
    assert.equal((await request(null, '/room-media/search', { Cookie: `session_token=${who.token}`,
        'X-Finitude-Room-Client': who.actor.clientId, 'X-Finitude-Account-Viewer': inactive.actor.userId })).status, 409);
    assert.equal((await request(who, `/room-media/${id(1)}`, { 'X-Finitude-Room-Client': 'short' })).status, 400);
    for (const path of ['/room-media/search?q=one&q=two', '/room-media/search?q[x]=one', '/room-media/search?q=%00',
        '/room-media/search?q=' + 'a'.repeat(101), '/room-media/search?limit=0', '/room-media/search?limit=51',
        '/room-media/search?limit=1.2', '/room-media/search?limit=01', '/room-media/search?limit=2&limit=3',
        '/room-media/search?unknown=true', '/room-media/search?cursor=', '/room-media/search?cursor=forged',
        '/room-media/search?cursor=' + 'x'.repeat(1_025), '/room-media/search?cursor[x]=one',
        '/room-media?q=quiet', `/room-media/${id(1)}?q=quiet`, '/room-media/not-an-id', '/rooms/current?q=quiet']) {
        assert.equal((await request(who, path)).status, 400, path);
    }
});
