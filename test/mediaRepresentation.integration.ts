import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app';
import { createAudioTrackWeb } from '../src/controllers/contentManager/mediaController';
import { createRoomService } from '../src/application/rooms/roomService';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import { getS3 } from '../src/infrastructure/s3';
import { uploadAudioObject, deleteAudioObjectAndTrack } from '../src/services/audioStorageService';
import { resolveRoomAudioRepresentation, touchRoomAudioRepresentation } from '../src/services/mediaRepresentationService';
import { ROOM_LIMITS } from '../src/contracts/roomV1';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav, wavUploadFile } from './support/pcmWav';

let mongo: MongoReplicaSetHarness;
let storage: Awaited<ReturnType<typeof startLocalS3>>;
let server: Server;
let baseUrl: string;
const ownedEnvironment = ['AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'S3_BUCKET_NAME', 'S3_MAX_ATTEMPTS'] as const;
const oldEnvironment = Object.fromEntries(ownedEnvironment.map(key => [key, process.env[key]]));

before(async () => {
    mongo = await startMongoReplicaSet('archtree-media-representation-test');
    storage = await startLocalS3();
    process.env.AWS_ENDPOINT_URL_S3 = storage.endpoint;
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'owned-local-fixture';
    process.env.AWS_SECRET_ACCESS_KEY = 'owned-local-fixture-secret';
    delete process.env.AWS_SESSION_TOKEN;
    process.env.S3_BUCKET_NAME = storage.bucket;
    process.env.S3_MAX_ATTEMPTS = '2';
    server = await new Promise<Server>(resolve => {
        const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
    for (const collection of ['audioTracks', 'socialRooms', 'socialRoomOutbox', 'albums', 'artists', 'playlists', 'userSaves', 'userActivity']) {
        await getDb()!.collection(collection).deleteMany({});
    }
    storage.objects.clear(); storage.requests.length = 0;
    storage.controls.beforeRead = undefined; storage.controls.dropPutResponses = false;
});
after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    getS3().destroy();
    await storage?.stop(); await mongo?.stop();
    for (const key of ownedEnvironment) {
        if (oldEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = oldEnvironment[key];
    }
});

const uploadTrack = async (durationMs = 2000) => {
    const id = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({
        _id: id, title: 'Real PCM tone', s3Key: id.toHexString(), mediaType: 'audio',
        uploadStatus: 'pending', publicationStatus: 'ready', duration: '99:00'
    });
    await uploadAudioObject(id.toHexString(), wavUploadFile(createPcmWav(durationMs)), 'fixture-owner');
    const media = await resolveRoomAudioRepresentation(id.toHexString()); assert.ok(media);
    return media;
};

const roomFor = (media: Awaited<ReturnType<typeof uploadTrack>>, roomId = 'fixture-room') => ({
    _id: roomId, state: 'open', epoch: 1, revision: 1, hostMembershipId: 'host-member', controlMode: 'everyone',
    controlGeneration: 1, queueRevision: 1, playbackGeneration: 1, members: [],
    queue: [{ ...media, entryId: 'first-entry' }],
    timeline: { entryId: 'first-entry', state: 'playing', positionMs: 0, anchorServerTimeMs: Date.now() },
    preparation: { preparationId: 'preparation', playbackGeneration: 1, entryId: 'first-entry', mediaRevision: media.mediaRevision, targetPositionMs: 0, deadlineAt: new Date(Date.now() + 3000), cohort: [] },
    transfer: null, hostAbsentSince: null, hostSuspended: false, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
});

test('real SDK upload atomically publishes validated duration and validators, then HTTP HEAD/GET/Range pin exact bytes', async () => {
    const media = await uploadTrack(2345);
    assert.equal(media.durationMs, 2345);
    const track = await getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(media.mediaTrackId) });
    const object = storage.objects.get(track!.s3Key)!;
    assert.equal(track!.mediaRepresentation.etag, object.etag);
    assert.equal(track!.mediaRepresentation.versionId, object.versionId);
    for (const method of ['HEAD', 'GET']) {
        const response = await fetch(baseUrl + media.streamUrl, { method });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('etag'), object.etag);
        assert.equal(response.headers.get('content-type'), 'audio/wav');
        assert.equal(Number(response.headers.get('content-length')), object.bytes.length);
        assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
        if (method === 'GET') assert.deepEqual(Buffer.from(await response.arrayBuffer()), object.bytes);
    }
    const partial = await fetch(baseUrl + media.streamUrl, { headers: { Range: 'bytes=40-79' } });
    assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), object.bytes.subarray(40, 80));
    assert.equal(partial.headers.get('content-range'), `bytes 40-79/${object.bytes.length}`);
    const pinnedRequests = storage.requests.filter(value => value.method === 'HEAD' || value.method === 'GET');
    assert.ok(pinnedRequests.length >= 5);
    assert.ok(pinnedRequests.every(value => value.ifMatch === object.etag && value.versionId === object.versionId));
});

test('real room media listing resolves uploaded ready bytes with a valid fallback title', async () => {
    const media = await uploadTrack();
    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(media.mediaTrackId) }, { $set: { title: ' ' } });
    const owner = new ObjectId(); const session = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id: owner, email: `${owner}@example.test` });
    await getDb()!.collection('authSessions').insertOne({ _id: session, userId: String(owner), expiresAt: new Date(Date.now() + 60_000) });
    await getDb()!.collection('socialProfiles').insertOne({ _id: 'sp_fixture-media-list' as any, accountId: String(owner), handle: 'media_fixture', active: true });
    const items = await createRoomService().eligibleMedia({ userId: String(owner), sessionId: String(session), clientId: 'fixture-client-123456' });
    assert.deepEqual(items, [{ ...media, title: 'Audio' }]);
});

test('replacement rotates revision and pauses rooms atomically; legacy URL plays latest while every stale pinned request fails', async () => {
    const original = await uploadTrack();
    const previousTrack = await getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(original.mediaTrackId) });
    await getDb()!.collection('socialRooms').insertOne(roomFor(original));
    await uploadAudioObject(original.mediaTrackId, wavUploadFile(createPcmWav(3000)), 'fixture-owner');
    const replacement = await resolveRoomAudioRepresentation(original.mediaTrackId); assert.ok(replacement);
    assert.notEqual(replacement.mediaRevision, original.mediaRevision); assert.equal(replacement.durationMs, 3000);
    const room = await getDb()!.collection('socialRooms').findOne({ _id: 'fixture-room' } as any);
    assert.equal(room!.timeline.state, 'paused'); assert.equal(room!.queue[0].unavailable, true);
    assert.equal(room!.preparation, null); assert.equal(room!.playbackGeneration, 2);
    assert.ok(await getDb()!.collection('socialRoomOutbox').findOne({ _id: 'fixture-room' } as any));
    assert.ok(storage.requests.some(value => value.method === 'DELETE'
        && value.key === previousTrack!.s3Key && value.versionId === previousTrack!.mediaRepresentation.versionId));
    for (const method of ['HEAD', 'GET']) {
        for (const headers of [{}, { Range: 'bytes=0-43', 'If-Range': '"stale"' }]) {
            assert.equal((await fetch(baseUrl + original.streamUrl, { method, headers })).status, 404);
        }
    }
    const latest = await fetch(`${baseUrl}/content/mediaTrack/stream/${original.mediaTrackId}`);
    assert.equal(latest.status, 200); assert.deepEqual(Buffer.from(await latest.arrayBuffer()), createPcmWav(3000));
});

test('pinned streams reject substituted storage bytes and malformed revisions before serving a body', async () => {
    const media = await uploadTrack();
    const track = await getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(media.mediaTrackId) });
    const object = storage.objects.get(track!.s3Key)!;
    storage.objects.set(track!.s3Key, { ...object, etag: '"substituted"', bytes: createPcmWav(1000) });
    for (const method of ['HEAD', 'GET']) assert.equal((await fetch(baseUrl + media.streamUrl, { method })).status, 404);
    const count = storage.requests.length;
    for (const suffix of ['?revision=invalid', '?revision[]=value', `?revision=${media.mediaRevision}&revision=${media.mediaRevision}`]) {
        assert.equal((await fetch(`${baseUrl}/content/mediaTrack/stream/${media.mediaTrackId}${suffix}`)).status, 400);
    }
    assert.equal(storage.requests.length, count);
});

test('replacement between HEAD and GET fails its object condition before emitting media response headers', async () => {
    const media = await uploadTrack();
    storage.controls.beforeRead = async (method, key) => {
        if (method !== 'GET') return;
        const object = storage.objects.get(key)!;
        storage.objects.set(key, { ...object, etag: '"bytes-replaced-after-head"' });
    };
    const response = await fetch(baseUrl + media.streamUrl, { headers: { Range: 'bytes=0-43' } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test('room admission write fence serializes with replacement and committed rooms are invalidated', async () => {
    const media = await uploadTrack();
    const session = getDatabaseClient().startSession(); session.startTransaction();
    try {
        assert.ok(await touchRoomAudioRepresentation(media.mediaTrackId, media.mediaRevision, session));
        const replacement = uploadAudioObject(media.mediaTrackId, wavUploadFile(createPcmWav(3000)), 'fixture-owner');
        await getDb()!.collection('socialRooms').insertOne(roomFor(media), { session });
        await session.commitTransaction(); await replacement;
        const room = await getDb()!.collection('socialRooms').findOne({ _id: 'fixture-room' } as any);
        assert.equal(room!.timeline.state, 'paused'); assert.equal(room!.queue[0].unavailable, true);
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
});

test('room invalidation failure rolls back byte promotion and preserves the old ready representation', async () => {
    const media = await uploadTrack();
    await getDb()!.collection('socialRooms').insertMany(Array.from({ length: ROOM_LIMITS.activeRooms + 1 }, (_, index) => roomFor(media, `fixture-${index}`)));
    await assert.rejects(uploadAudioObject(media.mediaTrackId, wavUploadFile(createPcmWav(3000)), 'fixture-owner'));
    assert.deepEqual(await resolveRoomAudioRepresentation(media.mediaTrackId), media);
    const response = await fetch(baseUrl + media.streamUrl); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), createPcmWav());
    assert.equal(await getDb()!.collection('socialRoomOutbox').countDocuments({}), 0);
    assert.equal(storage.objects.size, 1);
});

test('deletion invalidates exact representations before storage removal and final metadata deletion', async () => {
    const media = await uploadTrack();
    await getDb()!.collection('socialRooms').insertOne(roomFor(media));
    const previousTrack = await getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(media.mediaTrackId) });
    await deleteAudioObjectAndTrack(media.mediaTrackId, {
        prepareTrackCoverArtAssets: async () => [], finalizeTrackCoverArtAssets: async () => undefined
    });
    assert.equal(await resolveRoomAudioRepresentation(media.mediaTrackId), null);
    assert.equal((await fetch(baseUrl + media.streamUrl)).status, 404);
    const room = await getDb()!.collection('socialRooms').findOne({ _id: 'fixture-room' } as any);
    assert.equal(room!.timeline.state, 'paused'); assert.equal(room!.queue[0].unavailable, true);
    assert.equal(storage.objects.size, 0);
    assert.ok(storage.requests.some(value => value.method === 'DELETE'
        && value.key === previousTrack!.s3Key && value.versionId === previousTrack!.mediaRepresentation.versionId));
});

test('failed S3 deletion retains exact representation evidence while atomically removing room eligibility', async () => {
    const media = await uploadTrack();
    await getDb()!.collection('socialRooms').insertOne(roomFor(media));
    await assert.rejects(deleteAudioObjectAndTrack(media.mediaTrackId, {
        prepareTrackCoverArtAssets: async () => [], finalizeTrackCoverArtAssets: async () => undefined,
        deleteAudioObject: async () => { throw new Error('Injected storage unavailability.'); }
    }));
    const track = await getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(media.mediaTrackId) });
    assert.equal(track!.uploadStatus, 'deleteFailed');
    assert.equal(track!.mediaRepresentation.revision, media.mediaRevision);
    assert.equal(await resolveRoomAudioRepresentation(media.mediaTrackId), null);
    assert.equal((await fetch(baseUrl + media.streamUrl)).status, 404);
    assert.equal(storage.objects.size, 1);
    const room = await getDb()!.collection('socialRooms').findOne({ _id: 'fixture-room' } as any);
    assert.equal(room!.timeline.state, 'paused'); assert.equal(room!.queue[0].unavailable, true);
});

test('lost PUT responses preserve one conditional object and explicit reconciliation state in initial Content Manager creation', async () => {
    const owner = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id: owner, role: 'admin', email: `${owner}@example.test` });
    const previousVersions = storage.uploadedVersionCount;
    storage.controls.dropPutResponses = true;
    let redirect = '';
    await createAudioTrackWeb({
        body: { title: 'Uncertain initial upload', attributionUnknown: 'true' },
        auth: { userId: owner.toHexString(), role: 'admin' },
        files: { mediaFile: [wavUploadFile()] }
    } as any, { redirect: (location: string) => { redirect = location; }, locals: {} } as any,
    error => { throw error; });
    assert.match(decodeURIComponent(redirect), /upload outcome could not be confirmed/);
    assert.match(decodeURIComponent(redirect), /reconciliation is required before retrying/);
    const track = await getDb()!.collection('audioTracks').findOne({ title: 'Uncertain initial upload' });
    assert.ok(track);
    assert.equal(track.pendingUploadOutcomeUnknown, true);
    assert.equal(track.pendingUploadStatus, 'failed');
    assert.equal(track.uploadStatus, 'failed');
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.uploadedVersionCount, previousVersions + 1);
    assert.equal(storage.requests.filter(value => value.method === 'PUT' && value.key === track.pendingS3Key).length, 2);
    assert.equal(storage.objects.get(track.pendingS3Key)?.versionId, `fixture-${previousVersions + 1}`);
    await assert.rejects(uploadAudioObject(String(track._id), wavUploadFile(), owner.toHexString()),
        (error: any) => error.code === 'audio_upload_outcome_unknown');
    await assert.rejects(deleteAudioObjectAndTrack(String(track._id)),
        (error: any) => error.code === 'audio_upload_outcome_unknown');
    assert.equal(storage.objects.size, 1);
});
