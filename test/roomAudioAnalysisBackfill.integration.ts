import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDb } from '../src/infrastructure/database';
import { ROOM_AUDIO_ANALYSIS_VERSION } from '../src/models/mediaRepresentation';
import { roomAudioRepresentationForTrack } from '../src/services/mediaRepresentationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav } from './support/pcmWav';

/** Runs the documented backfill against owned loopback fixtures while bounding all captured output. */
const runCli = (args: string[], environment: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/backfill-room-audio-analysis.ts', import.meta.url)), ...args], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', value => { stdout += value.toString(); if (stdout.length > 64 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', value => { stderr += value.toString(); if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error('The backfill CLI did not complete within its fixture bounds.'));
        else resolve({ code, stdout, stderr });
    });
});

const lines = (output: string) => output.trim().split('\n').map(line => JSON.parse(line));
const summaryOf = (output: string) => {
    const entries = lines(output);
    const summary = entries[entries.length - 1];
    assert.equal(summary.type, 'summary');
    return summary;
};

test('the backfill CLI previews, analyzes in resumable paced runs, then finds nothing left on synthetic catalog data', async () => {
    let mongo: MongoReplicaSetHarness | undefined;
    let storage: Awaited<ReturnType<typeof startLocalS3>> | undefined;
    let client: S3Client | undefined;
    const logDirectory = await mkdtemp(join(tmpdir(), 'archtree-room-audio-backfill-'));
    try {
        mongo = await startMongoReplicaSet('archtree-room-audio-backfill-test');
        storage = await startLocalS3('room-audio-backfill');
        client = new S3Client({ endpoint: storage.endpoint, region: 'us-east-1', forcePathStyle: true,
            credentials: { accessKeyId: 'owned-loopback-fixture', secretAccessKey: 'owned-loopback-fixture-secret' }, maxAttempts: 1 });
        const admin = new ObjectId(), listener = new ObjectId();
        // Created in ascending order so the catalog cursor visits them in this sequence.
        const fresh = new ObjectId(), decoderMissing = new ObjectId(), unpublished = new ObjectId(), pendingUpload = new ObjectId();
        await getDb()!.collection('users').insertMany([
            { _id: admin, email: 'backfill-admin@example.test', role: 'admin' },
            { _id: listener, email: 'backfill-listener@example.test', role: 'user' }
        ]);
        const put = async (trackId: ObjectId, bytes: Buffer, contentType: string) => {
            const key = `audio/${trackId}/${new ObjectId()}`;
            const result = await client!.send(new PutObjectCommand({ Bucket: storage!.bucket, Key: key, Body: bytes, ContentType: contentType }));
            return { key, bytes, etag: result.ETag!, versionId: result.VersionId ?? null };
        };
        const freshObject = await put(fresh, createPcmWav(1500), 'audio/wav');
        // Original 2-second synthetic MP3; analyzing it requires the operator's real FFmpeg, as in production.
        const missingObject = await put(decoderMissing, await readFile(new URL('./fixtures/room-audio/cbr.mp3', import.meta.url)), 'audio/mpeg');
        const unpublishedObject = await put(unpublished, createPcmWav(1000), 'audio/wav');
        await getDb()!.collection('audioTracks').insertMany([
            { _id: fresh, title: 'Private fixture title', s3Key: freshObject.key, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready' },
            // The state an MP3 upload recorded while the Elastic Beanstalk instance had no decoder.
            { _id: decoderMissing, title: 'Private fixture title', s3Key: missingObject.key, mediaType: 'audio', uploadStatus: 'ready',
                publicationStatus: 'ready', mediaRepresentation: { revision: `mr_${'1'.repeat(32)}`, objectKey: missingObject.key,
                    byteLength: missingObject.bytes.length, durationMs: null, seekable: false, format: 'unsupported',
                    analysisVersion: ROOM_AUDIO_ANALYSIS_VERSION, analysisFailure: 'decoder_unavailable',
                    etag: missingObject.etag, versionId: missingObject.versionId } },
            { _id: unpublished, title: 'Private fixture title', s3Key: unpublishedObject.key, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'pending' },
            { _id: pendingUpload, title: 'Private fixture title', mediaType: 'audio', uploadStatus: 'pending' }
        ]);
        storage.requests.length = 0;
        const environment: NodeJS.ProcessEnv = { ...process.env, AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'owned-loopback-fixture', AWS_SECRET_ACCESS_KEY: 'owned-loopback-fixture-secret',
            S3_BUCKET_NAME: storage.bucket, S3_MAX_ATTEMPTS: '1' };
        delete environment.AWS_SESSION_TOKEN;
        const log = join(logDirectory, 'backfill.jsonl');
        const before = await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray();

        const dryRun = await runCli([`--admin-id=${admin}`, `--log=${log}`], environment);
        assert.equal(dryRun.code, 0, dryRun.stderr);
        assert.equal(dryRun.stderr, '');
        assert.deepEqual(lines(dryRun.stdout).slice(0, -1).map(entry => [entry.mediaTrackId, entry.result]),
            [[String(fresh), 'wouldAnalyze'], [String(decoderMissing), 'wouldAnalyze']], 'unpublished and unfinished uploads are never selected');
        assert.equal(summaryOf(dryRun.stdout).dryRun, true);
        assert.equal(storage.requests.length, 0);
        assert.deepEqual(await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray(), before);
        assert.equal((await stat(log)).mode & 0o777, 0o600);

        const denied = await runCli([`--admin-id=${listener}`, '--apply', '--confirm=BACKFILL_ROOM_AUDIO'], environment);
        assert.equal(denied.code, 1);
        assert.equal(denied.stdout, '');
        assert.equal(storage.requests.length, 0);

        const capped = await runCli([`--admin-id=${admin}`, `--log=${log}`, '--max-analyses=1', '--delay-ms=0',
            '--apply', '--confirm=BACKFILL_ROOM_AUDIO'], environment);
        assert.equal(capped.code, 2, capped.stderr);
        const cappedSummary = summaryOf(capped.stdout);
        assert.deepEqual([cappedSummary.stopReason, cappedSummary.resumeAfter, cappedSummary.counts], ['limit', String(fresh), { complete: 1 }]);
        assert.equal(roomAudioRepresentationForTrack(await getDb()!.collection('audioTracks').findOne({ _id: fresh }))?.durationMs, 1500);
        assert.equal(roomAudioRepresentationForTrack(await getDb()!.collection('audioTracks').findOne({ _id: decoderMissing })), null);

        const resumed = await runCli([`--admin-id=${admin}`, `--log=${log}`, `--after=${cappedSummary.resumeAfter}`, '--delay-ms=10',
            '--apply', '--confirm=BACKFILL_ROOM_AUDIO'], environment);
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.deepEqual(lines(resumed.stdout).slice(0, -1).map(entry => [entry.mediaTrackId, entry.result]), [[String(decoderMissing), 'complete']]);
        assert.equal(summaryOf(resumed.stdout).finished, true);
        const repaired = await getDb()!.collection('audioTracks').findOne({ _id: decoderMissing });
        assert.equal(repaired!.mediaRepresentation.format, 'mp3');
        assert.equal(roomAudioRepresentationForTrack(repaired)?.durationMs, 2000);
        assert.equal(repaired!.s3Key, missingObject.key, 'analysis never replaces the stored source');
        assert.ok(storage.requests.length > 0);
        assert.ok(storage.requests.every(request => request.method === 'HEAD' || request.method === 'GET'));

        const requestCount = storage.requests.length;
        const settled = await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray();
        const repeated = await runCli([`--admin-id=${admin}`, `--log=${log}`, '--apply', '--confirm=BACKFILL_ROOM_AUDIO'], environment);
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.deepEqual(summaryOf(repeated.stdout).counts, { skipped: 2 });
        assert.equal(summaryOf(repeated.stdout).analyses, 0);
        assert.equal(storage.requests.length, requestCount, 'a completed backfill reads no storage when repeated');
        assert.deepEqual(await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray(), settled);

        // Every run appended to the same private audit trail without exposing catalog or storage details.
        const audit = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(audit.filter(entry => entry.type === 'summary').length, 4);
        assert.doesNotMatch(await readFile(log, 'utf8'), /Private fixture title|audio\/|sourceRevision|attemptId|etag|owned-loopback/);
    } finally {
        client?.destroy();
        await storage?.stop();
        await mongo?.stop();
        await rm(logDirectory, { recursive: true, force: true });
    }
});
