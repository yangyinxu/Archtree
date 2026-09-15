import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectId, type Db } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { createRoomAudioAnalysisService, RoomAudioAnalysisError, ROOM_AUDIO_ANALYSIS_VERSION, type RoomAudioAnalysisDependencies } from '../src/services/roomAudioAnalysisService';
import { inspectRoomAudioFile, RoomAudioInspectionError } from '../src/services/roomAudioInspection';
import { roomAudioRepresentationForTrack } from '../src/services/mediaRepresentationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav } from './support/pcmWav';

let mongo: MongoReplicaSetHarness;
let storage: Awaited<ReturnType<typeof startLocalS3>>;
let client: S3Client;
let admin: ObjectId;
let listener: ObjectId;
const previousBucket = process.env.S3_BUCKET_NAME;

before(async () => {
    mongo = await startMongoReplicaSet('archtree-room-audio-analysis-test');
    storage = await startLocalS3('room-audio-analysis');
    process.env.S3_BUCKET_NAME = storage.bucket;
    client = new S3Client({ endpoint: storage.endpoint, region: 'us-east-1', forcePathStyle: true,
        credentials: { accessKeyId: 'owned-loopback-fixture', secretAccessKey: 'owned-loopback-fixture-secret' }, maxAttempts: 1 });
});
beforeEach(async () => {
    await getDb()!.collection('audioTracks').deleteMany({});
    await getDb()!.collection('users').deleteMany({});
    storage.objects.clear(); storage.requests.length = 0; storage.controls.beforeRead = undefined;
    admin = new ObjectId(); listener = new ObjectId();
    await getDb()!.collection('users').insertMany([
        { _id: admin, email: 'analysis-admin@example.test', role: 'admin' },
        { _id: listener, email: 'analysis-listener@example.test', role: 'user' }
    ]);
});
after(async () => {
    client?.destroy(); await storage?.stop(); await mongo?.stop();
    if (previousBucket === undefined) delete process.env.S3_BUCKET_NAME; else process.env.S3_BUCKET_NAME = previousBucket;
});

const service = (overrides: Partial<RoomAudioAnalysisDependencies> = {}) =>
    createRoomAudioAnalysisService({ storage: () => client, ...overrides });
const readTrack = (id: string) => getDb()!.collection('audioTracks').findOne({ _id: new ObjectId(id) });

/** Seed a historical catalog record through the real SDK, before counting any analysis storage access. */
const legacyTrack = async (bytes = createPcmWav(2345), overrides: Record<string, unknown> = {}) => {
    const id = new ObjectId(); const objectKey = `audio/${id.toHexString()}/${new ObjectId().toHexString()}`;
    const uploaded = await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: objectKey, Body: bytes, ContentType: 'audio/wav' }));
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title: 'Historical audio', duration: '99:00',
        s3Key: objectKey, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready',
        createdBy: 'private-owner', internalError: 'private-provider-diagnostic', ...overrides });
    return { id: id.toHexString(), objectKey, bytes, etag: uploaded.ETag!, versionId: uploaded.VersionId! };
};
const intentFor = async (api: ReturnType<typeof service>, mediaTrackId: string) => {
    const row = (await api.list({ actorId: admin.toHexString() })).items.find(value => value.mediaTrackId === mediaTrackId);
    assert.ok(row);
    return { actorId: admin.toHexString(), mediaTrackId, sourceRevision: row.sourceRevision, attemptId: row.attemptId };
};
const assertNoStorageMutation = (requests: typeof storage.requests) =>
    assert.ok(requests.every(value => value.method === 'HEAD' || value.method === 'GET'), 'Analysis must never PUT or DELETE media bytes.');
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
};

/** Decode real bytes, then hold one known completion boundary for a deterministic database race. */
const inspectionBarrier = () => {
    const entered = deferred(), release = deferred();
    let path: string | undefined;
    const inspect: typeof inspectRoomAudioFile = async (file, options) => {
        path = file.path;
        const result = await inspectRoomAudioFile(file, options);
        entered.resolve(); await release.promise;
        return result;
    };
    return { entered, release, inspect, path: () => path };
};

test('analysis rechecks administrator access, validates requests and emits only bounded safe list fields', async () => {
    const track = await legacyTrack(); const api = service();
    for (const actorId of ['invalid', new ObjectId().toHexString(), listener.toHexString()]) {
        await assert.rejects(api.list({ actorId }), (error: unknown) => error instanceof RoomAudioAnalysisError && error.statusCode === 403);
        await assert.rejects(api.analyze({ actorId, mediaTrackId: track.id, sourceRevision: '0'.repeat(64), attemptId: '0'.repeat(32) }),
            (error: unknown) => error instanceof RoomAudioAnalysisError && error.statusCode === 403);
    }
    for (const input of [{ limit: 0 }, { limit: 101 }, { after: 'not-an-id' }]) {
        await assert.rejects(api.list({ actorId: admin.toHexString(), ...input }),
            (error: unknown) => error instanceof RoomAudioAnalysisError && error.statusCode === 400);
    }
    const page = await api.list({ actorId: admin.toHexString(), limit: 1 });
    assert.equal(page.items.length, 1); assert.equal(page.nextAfter, null);
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['attemptId', 'mediaTrackId', 'reason', 'sourceRevision', 'status', 'title', 'updatedAt']);
    assert.equal(page.items[0].status, 'notAnalyzed');
    assert.match(page.items[0].sourceRevision, /^[a-f0-9]{64}$/); assert.match(page.items[0].attemptId, /^[a-f0-9]{32}$/);
    const serialized = JSON.stringify(page);
    for (const secret of [track.objectKey, track.etag, track.versionId, 'private-owner', 'private-provider-diagnostic']) assert.ok(!serialized.includes(secret));
    const input = await intentFor(api, track.id);
    await getDb()!.collection('users').updateOne({ _id: admin }, { $set: { role: 'user' } });
    await assert.rejects(api.analyze(input), (error: unknown) => error instanceof RoomAudioAnalysisError && error.statusCode === 403);
    assert.equal((await readTrack(track.id))!.roomAudioAnalysis, undefined);
});

test('historical MP3 and AAC use pinned reads to publish verified duration without changing or uploading their source', async t => {
    for (const [filename, format, expectedDuration] of [['cbr.mp3', 'mp3', 2000], ['aac-lc.m4a', 'm4a-aac', 2000]] as const) {
        await t.test(format, async () => {
            const bytes = await readFile(new URL(`./fixtures/room-audio/${filename}`, import.meta.url));
            const track = await legacyTrack(bytes); const api = service(); const input = await intentFor(api, track.id);
            const start = storage.requests.length;
            const outcome = await api.analyze(input);
            assert.equal(outcome.outcome, 'complete'); assert.equal(outcome.reason, null);
            const updated = (await readTrack(track.id))!;
            assert.equal(updated.s3Key, track.objectKey); assert.equal(updated.duration, '99:00');
            assert.deepEqual(storage.objects.get(track.objectKey)!.bytes, bytes);
            assert.equal(updated.mediaRepresentation.format, format);
            assert.equal(updated.mediaRepresentation.etag, track.etag); assert.equal(updated.mediaRepresentation.versionId, track.versionId);
            const eligible = roomAudioRepresentationForTrack(updated); assert.ok(eligible);
            assert.equal(eligible.durationMs, expectedDuration);
            const reads = storage.requests.slice(start); assertNoStorageMutation(reads);
            const gets = reads.filter(value => value.method === 'GET'); assert.equal(gets.length, 1);
            assert.equal(gets[0].ifMatch, track.etag); assert.equal(gets[0].versionId, track.versionId);
            assert.equal((await api.list({ actorId: admin.toHexString() })).items.find(value => value.mediaTrackId === track.id)!.status, 'eligible');
            const afterComplete = storage.requests.length;
            assert.deepEqual(await api.analyze(input), outcome);
            assert.equal((await api.analyze(await intentFor(api, track.id))).outcome, 'complete');
            assert.equal(storage.requests.length, afterComplete, 'Completed and eligible intents must not read or rewrite storage again.');
        });
    }
});

test('an existing unsupported representation keeps exact validators while analysis makes the original bytes eligible', async () => {
    const track = await legacyTrack();
    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(track.id) }, { $set: { mediaRepresentation: {
        revision: `mr_${randomBytes(16).toString('hex')}`, objectKey: track.objectKey, byteLength: track.bytes.length,
        durationMs: null, seekable: false, format: 'unsupported', etag: track.etag, versionId: track.versionId
    } } });
    const api = service(); const input = await intentFor(api, track.id); const before = storage.requests.length;
    assert.equal((await api.analyze(input)).outcome, 'complete');
    const reads = storage.requests.slice(before); assertNoStorageMutation(reads);
    assert.ok(reads.every(value => value.ifMatch === track.etag && value.versionId === track.versionId));
    assert.equal(roomAudioRepresentationForTrack(await readTrack(track.id))?.durationMs, 2345);
});

test('unsupported bytes retain durable analysis evidence and identical retries do not read storage again', async () => {
    const track = await legacyTrack(Buffer.from('original unsupported media payload'));
    const api = service(); const input = await intentFor(api, track.id);
    const result = await api.analyze(input);
    assert.equal(result.outcome, 'unsupported'); assert.equal(result.reason, 'unsupported_audio');
    const updated = (await readTrack(track.id))!;
    assert.equal(updated.mediaRepresentation.seekable, false); assert.equal(updated.mediaRepresentation.format, 'unsupported');
    assert.equal(updated.mediaRepresentation.objectKey, track.objectKey); assert.equal(updated.mediaRepresentation.etag, track.etag);
    assert.equal(updated.roomAudioAnalysis.attemptId, input.attemptId); assert.equal(roomAudioRepresentationForTrack(updated), null);
    const row = (await api.list({ actorId: admin.toHexString() })).items[0];
    assert.equal(row.status, 'unsupported'); assert.equal(row.attemptId, input.attemptId);
    const requests = storage.requests.length;
    assert.deepEqual(await api.analyze(input), result); assert.equal(storage.requests.length, requests);
    const currentIntent = await intentFor(api, track.id);
    assert.notEqual(currentIntent.sourceRevision, input.sourceRevision, 'The completed representation changes the current source fingerprint.');
    assert.equal(currentIntent.attemptId, input.attemptId);
    assert.deepEqual(await api.analyze(currentIntent), result);
    assert.equal(storage.requests.length, requests, 'The terminal result also applies to a newly listed source fingerprint.');
    assert.deepEqual(await readTrack(track.id), updated, 'Terminal retries must not replace attempt or representation evidence.');

    const replacementKey = `audio/${track.id}/${new ObjectId().toHexString()}`;
    await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: replacementKey, Body: createPcmWav(2345), ContentType: 'audio/wav' }));
    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(track.id) },
        { $set: { s3Key: replacementKey }, $unset: { mediaRepresentation: '' } });
    assert.equal((await api.list({ actorId: admin.toHexString() })).items[0].status, 'notAnalyzed');
    assert.equal((await api.analyze(await intentFor(api, track.id))).outcome, 'complete', 'Replacing the source permits new analysis.');
});

test('upload-time unsupported evidence is terminal while decoder infrastructure failures remain retryable', async () => {
    const track = await legacyTrack();
    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(track.id) }, { $set: { mediaRepresentation: {
        revision: `mr_${randomBytes(16).toString('hex')}`, objectKey: track.objectKey, byteLength: track.bytes.length,
        durationMs: null, seekable: false, format: 'unsupported', etag: track.etag, versionId: track.versionId,
        analysisVersion: ROOM_AUDIO_ANALYSIS_VERSION
    } } });
    let inspections = 0;
    const api = service({ inspect: async (...args) => { inspections += 1; return inspectRoomAudioFile(...args); } });
    const input = await intentFor(api, track.id); const before = await readTrack(track.id); const requests = storage.requests.length;
    assert.equal((await api.list({ actorId: admin.toHexString() })).items[0].status, 'unsupported');
    assert.deepEqual(await api.analyze(input), { mediaTrackId: track.id, attemptId: input.attemptId,
        outcome: 'unsupported', reason: 'unsupported_audio' });
    assert.equal(inspections, 0); assert.equal(storage.requests.length, requests);
    assert.deepEqual(await readTrack(track.id), before, 'No analysis record is created for an already terminal upload.');

    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(track.id) },
        { $set: { 'mediaRepresentation.analysisFailure': 'decoder_unavailable' } });
    assert.equal((await api.list({ actorId: admin.toHexString() })).items[0].status, 'retryable');
    assert.equal((await api.analyze(await intentFor(api, track.id))).outcome, 'complete');
    assert.equal(inspections, 1);
});

test('list pagination advances across excluded Video and refuses analysis during pending replacement', async () => {
    const first = await legacyTrack(); const video = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id: video, title: 'Video', mediaType: 'video',
        s3Key: `video/${video.toHexString()}/${new ObjectId().toHexString()}`, uploadStatus: 'ready', publicationStatus: 'ready' });
    const last = await legacyTrack(); const api = service();
    const firstPage = await api.list({ actorId: admin.toHexString(), limit: 1 });
    assert.deepEqual(firstPage.items.map(value => value.mediaTrackId), [first.id]); assert.equal(firstPage.nextAfter, first.id);
    const gap = await api.list({ actorId: admin.toHexString(), limit: 1, after: firstPage.nextAfter! });
    assert.deepEqual(gap.items, []); assert.equal(gap.nextAfter, video.toHexString());
    const lastPage = await api.list({ actorId: admin.toHexString(), limit: 1, after: gap.nextAfter! });
    assert.deepEqual(lastPage.items.map(value => value.mediaTrackId), [last.id]); assert.equal(lastPage.nextAfter, null);
    const input = await intentFor(api, first.id);
    await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(first.id) },
        { $set: { pendingS3Key: `audio/${first.id}/${new ObjectId().toHexString()}` } });
    const requests = storage.requests.length;
    assert.equal((await api.analyze(input)).outcome, 'stale'); assert.equal(storage.requests.length, requests);
    assert.equal((await readTrack(first.id))!.roomAudioAnalysis, undefined);
});

test('conditional storage reads reject substituted bytes with stale source evidence instead of a retryable outage', async t => {
    for (const phase of ['get-version', 'get-etag', 'final-head'] as const) {
        await t.test(phase, async () => {
            const track = await legacyTrack(); const api = service(); const input = await intentFor(api, track.id);
            let heads = 0;
            storage.controls.beforeRead = async (method, key) => {
                if (key !== track.objectKey) return;
                if (method === 'HEAD') heads += 1;
                if ((method === 'GET' && phase.startsWith('get')) || (method === 'HEAD' && heads === 2 && phase === 'final-head')) {
                    const object = storage.objects.get(key)!;
                    storage.objects.set(key, phase === 'get-version' ? { ...object, versionId: 'replacement-version' }
                        : { ...object, etag: '"replacement-etag"' });
                }
            };
            const result = await api.analyze(input);
            assert.equal(result.outcome, 'stale'); assert.equal(result.reason, 'source_changed');
            assert.equal((await readTrack(track.id))!.mediaRepresentation, undefined);
            assert.equal((await readTrack(track.id))!.roomAudioAnalysis.state, 'stale');
        });
    }
});

test('source replacement during decoding cannot attach old analysis and the private temporary file is removed', { timeout: 15_000 }, async () => {
    const track = await legacyTrack(); const barrier = inspectionBarrier(); const api = service({ inspect: barrier.inspect });
    const replacementKey = `audio/${track.id}/${new ObjectId().toHexString()}`;
    const input = await intentFor(api, track.id); const pending = api.analyze(input);
    await barrier.entered.promise;
    try {
        await getDb()!.collection('audioTracks').updateOne({ _id: new ObjectId(track.id) }, { $set: { s3Key: replacementKey } });
    } finally { barrier.release.resolve(); }
    assert.equal((await pending).outcome, 'stale');
    const updated = (await readTrack(track.id))!;
    assert.equal(updated.s3Key, replacementKey); assert.equal(updated.mediaRepresentation, undefined);
    assert.ok(barrier.path()); await assert.rejects(access(barrier.path()!));
});

test('administrator demotion during decoding prevents promotion even after the initial authorization succeeds', { timeout: 15_000 }, async () => {
    const track = await legacyTrack(); const barrier = inspectionBarrier(); const api = service({ inspect: barrier.inspect });
    const pending = api.analyze(await intentFor(api, track.id));
    await barrier.entered.promise;
    try { await getDb()!.collection('users').updateOne({ _id: admin }, { $set: { role: 'user' } }); }
    finally { barrier.release.resolve(); }
    const outcome = await pending; assert.equal(outcome.outcome, 'failed'); assert.equal(outcome.reason, 'analysis_failed');
    assert.equal((await readTrack(track.id))!.mediaRepresentation, undefined);
});

test('cancellation retains its original attempt for explicit retry and rejects a fresh identity for the same source', { timeout: 15_000 }, async () => {
    const track = await legacyTrack(); const entered = deferred(); const cancellation = new AbortController();
    const api = service({ inspect: async (_file, options) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Fixture cancellation', 'AbortError'));
            if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
        });
        return null;
    } });
    const input = await intentFor(api, track.id); const pending = api.analyze({ ...input, signal: cancellation.signal });
    await entered.promise; cancellation.abort();
    assert.deepEqual(await pending, { mediaTrackId: track.id, attemptId: input.attemptId, outcome: 'cancelled', reason: 'cancelled' });
    const retryApi = service(); const row = (await retryApi.list({ actorId: admin.toHexString() })).items[0];
    assert.equal(row.status, 'retryable'); assert.equal(row.reason, 'cancelled'); assert.equal(row.attemptId, input.attemptId);
    assert.equal((await retryApi.analyze({ ...input, attemptId: randomBytes(16).toString('hex') })).outcome, 'stale');
    assert.equal((await retryApi.analyze(input)).outcome, 'complete');
});

test('a decoder infrastructure failure remains retryable with safe reason and never marks valid content unsupported', async () => {
    const track = await legacyTrack(); const api = service({ inspect: async () => { throw new RoomAudioInspectionError('decoder_unavailable'); } });
    const input = await intentFor(api, track.id); const outcome = await api.analyze(input);
    assert.equal(outcome.outcome, 'failed'); assert.equal(outcome.reason, 'decoder_unavailable');
    const row = (await api.list({ actorId: admin.toHexString() })).items[0];
    assert.equal(row.status, 'retryable'); assert.equal(row.attemptId, input.attemptId);
    assert.equal((await readTrack(track.id))!.mediaRepresentation, undefined);
    assert.equal((await service().analyze(input)).outcome, 'complete');
});

test('an expired lease can be recovered by the same attempt and the earlier worker cannot overwrite its replacement', { timeout: 15_000 }, async () => {
    let now = Date.now(); const track = await legacyTrack(); const barrier = inspectionBarrier();
    const first = service({ now: () => now, inspect: barrier.inspect }); const second = service({ now: () => now });
    const input = await intentFor(first, track.id); const pending = first.analyze(input);
    await barrier.entered.promise;
    let winner: string;
    try {
        assert.equal((await second.analyze(input)).outcome, 'busy');
        now += 120_001;
        const row = (await second.list({ actorId: admin.toHexString() })).items[0];
        assert.equal(row.status, 'retryable'); assert.equal(row.reason, 'interrupted'); assert.equal(row.attemptId, input.attemptId);
        assert.equal((await second.analyze(input)).outcome, 'complete');
        winner = (await readTrack(track.id))!.mediaRepresentation.revision;
    } finally { barrier.release.resolve(); }
    assert.equal((await pending).outcome, 'stale');
    assert.equal((await readTrack(track.id))!.mediaRepresentation.revision, winner!);
});

/** Wrap only the actual track collection boundary while all Mongo reads/writes and predicates remain real. */
const databaseWithFinalWriteFault = (mode: 'committed' | 'unknown' | 'deleting' | 'reservation') => {
    const db = getDb()!; let triggered = false;
    return new Proxy(db, { get(target, property) {
        if (property === 'collection') return (name: string) => {
            const collection = target.collection(name);
            if (name !== 'audioTracks') return collection;
            return new Proxy(collection, { get(value, method) {
                if (method === 'updateOne') return async (...args: Parameters<typeof collection.updateOne>) => {
                    const faultState = mode === 'reservation' ? 'running' : 'complete';
                    if (!triggered && (args[1] as any).$set?.roomAudioAnalysis?.state === faultState) {
                        triggered = true;
                        if (mode !== 'unknown') await value.updateOne(...args);
                        if (mode === 'deleting') await value.updateOne({ _id: (args[0] as any)._id }, { $set: { uploadStatus: 'deleting' } });
                        throw new Error('Fixture lost final write acknowledgement');
                    }
                    return value.updateOne(...args);
                };
                if (method === 'findOne' && triggered && mode === 'unknown') return async () => { throw new Error('Fixture reconciliation unavailable'); };
                const member = Reflect.get(value, method); return typeof member === 'function' ? member.bind(value) : member;
            } });
        };
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
    } }) as Db;
};

test('a committed final write with a lost acknowledgement is reconciled as complete without another decode', async () => {
    const track = await legacyTrack(); let inspections = 0;
    const database = databaseWithFinalWriteFault('committed');
    const api = service({ database: () => database,
        inspect: async (...args) => { inspections += 1; return inspectRoomAudioFile(...args); } });
    const input = await intentFor(api, track.id);
    assert.equal((await api.analyze(input)).outcome, 'complete');
    assert.ok(roomAudioRepresentationForTrack(await readTrack(track.id)));
    assert.equal((await api.analyze(input)).outcome, 'complete'); assert.equal(inspections, 1);
});

test('an unresolved final write retains running evidence and can recover only after lease expiry with the original attempt', async () => {
    const track = await legacyTrack(); let now = Date.now();
    const database = databaseWithFinalWriteFault('unknown'); const api = service({ database: () => database, now: () => now });
    const input = await intentFor(api, track.id);
    assert.equal((await api.analyze(input)).outcome, 'unknown');
    const record = (await readTrack(track.id))!;
    assert.equal(record.mediaRepresentation, undefined); assert.equal(record.roomAudioAnalysis.state, 'running');
    assert.equal(record.roomAudioAnalysis.attemptId, input.attemptId);
    const recovered = service({ now: () => now });
    assert.equal((await recovered.analyze(input)).outcome, 'busy');
    now += 120_001;
    assert.equal((await recovered.analyze(input)).outcome, 'complete');
    assert.ok(roomAudioRepresentationForTrack(await readTrack(track.id)));
});

test('lost final acknowledgement followed by deletion is stale rather than a success reconstructed from obsolete attempt evidence', async () => {
    const track = await legacyTrack(); const database = databaseWithFinalWriteFault('deleting');
    const api = service({ database: () => database }); const input = await intentFor(api, track.id);
    const start = storage.requests.length;
    const outcome = await api.analyze(input);
    assert.equal(outcome.outcome, 'stale'); assert.equal(outcome.reason, 'source_changed');
    const record = (await readTrack(track.id))!;
    assert.equal(record.uploadStatus, 'deleting'); assert.equal(record.roomAudioAnalysis.state, 'complete');
    assert.equal(roomAudioRepresentationForTrack(record), null); assertNoStorageMutation(storage.requests.slice(start));
});

test('lost reservation acknowledgement retains the running attempt without reading storage until explicit expired-lease recovery', async () => {
    const track = await legacyTrack(); let now = Date.now(); const database = databaseWithFinalWriteFault('reservation');
    const api = service({ database: () => database, now: () => now }); const input = await intentFor(api, track.id);
    const start = storage.requests.length;
    const outcome = await api.analyze(input);
    assert.equal(outcome.outcome, 'unknown'); assert.equal(storage.requests.length, start);
    const trackAfter = (await readTrack(track.id))!;
    assert.equal(trackAfter.roomAudioAnalysis.state, 'running'); assert.equal(trackAfter.roomAudioAnalysis.attemptId, input.attemptId);
    assert.equal(trackAfter.mediaRepresentation, undefined);
    const recovered = service({ now: () => now });
    assert.equal((await recovered.analyze(input)).outcome, 'busy'); assert.equal(storage.requests.length, start);
    now += 120_001;
    assert.equal((await recovered.analyze(input)).outcome, 'complete');
    assert.ok(roomAudioRepresentationForTrack(await readTrack(track.id)));
});

test('cancellation during the initial track read dispatches no claim and reads no storage', { timeout: 15_000 }, async () => {
    const track = await legacyTrack(); const cancellation = new AbortController();
    const before = await readTrack(track.id); const start = storage.requests.length;
    let cancelledReads = 0;
    const database = new Proxy(getDb()!, { get(target, property) {
        if (property === 'collection') return (name: string) => {
            const collection = target.collection(name);
            if (name !== 'audioTracks') return collection;
            return new Proxy(collection, { get(value, method) {
                if (method === 'findOne') return async (...args: Parameters<typeof collection.findOne>) => {
                    const result = await value.findOne(...args);
                    assert.equal(String(result?._id), track.id);
                    cancelledReads += 1;
                    cancellation.abort();
                    return result;
                };
                const member = Reflect.get(value, method); return typeof member === 'function' ? member.bind(value) : member;
            } });
        };
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
    } }) as Db;
    const api = service({ database: () => database }); const input = await intentFor(api, track.id);
    assert.equal(cancellation.signal.aborted, false);
    const outcome = await api.analyze({ ...input, signal: cancellation.signal });
    assert.deepEqual(outcome, { mediaTrackId: track.id, attemptId: input.attemptId, outcome: 'cancelled', reason: 'cancelled' });
    assert.equal(cancelledReads, 1, 'Cancellation before claim dispatch needs no uncertain-write readback.');
    assert.equal(storage.requests.length, start);
    const afterCancellation = await readTrack(track.id);
    assert.equal(afterCancellation!.roomAudioAnalysis, undefined);
    assert.deepEqual(afterCancellation, before);
});

test('a malformed storage version validator remains retryable and cannot trigger a source download', { timeout: 15_000 }, async () => {
    const track = await legacyTrack();
    const malformedStorage = new Proxy(client, { get(target, property) {
        if (property === 'send') return async (command: any, options: any) => {
            const result = await target.send(command, options);
            return command instanceof HeadObjectCommand ? { ...result, VersionId: 42 } : result;
        };
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
    } }) as S3Client;
    const api = service({ storage: () => malformedStorage }); const input = await intentFor(api, track.id);
    const start = storage.requests.length;
    const outcome = await api.analyze(input);
    assert.deepEqual(outcome, { mediaTrackId: track.id, attemptId: input.attemptId, outcome: 'failed', reason: 'storage_unavailable' });
    assert.deepEqual(storage.requests.slice(start).map(request => request.method), ['HEAD']);
    const updated = (await readTrack(track.id))!;
    assert.equal(updated.mediaRepresentation, undefined);
    assert.equal(updated.roomAudioAnalysis.state, 'failed');
    const row = (await api.list({ actorId: admin.toHexString() })).items.find(value => value.mediaTrackId === track.id)!;
    assert.equal(row.status, 'retryable');
    assert.equal(row.reason, 'storage_unavailable');
    assert.equal(row.attemptId, input.attemptId);
});
