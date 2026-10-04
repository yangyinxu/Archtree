import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDb } from '../src/infrastructure/database';
import { roomAudioRepresentationForTrack } from '../src/services/mediaRepresentationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';
import { startLocalS3 } from './support/localS3';
import { createPcmWav } from './support/pcmWav';

/** Runs the documented executable against owned loopback fixtures while bounding all captured output. */
const runCli = (args: string[], environment: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/analyze-room-audio.ts', import.meta.url)), ...args], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', value => { stdout += value.toString(); if (stdout.length > 64 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', value => { stderr += value.toString(); if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error('The analysis CLI did not complete within its fixture bounds.'));
        else resolve({ code, stdout, stderr });
    });
});

test('the real CLI dry-run leaves catalog and storage unchanged, then explicit apply analyzes the same existing bytes', async () => {
    let mongo: MongoReplicaSetHarness | undefined;
    let storage: Awaited<ReturnType<typeof startLocalS3>> | undefined;
    let client: S3Client | undefined;
    try {
        mongo = await startMongoReplicaSet('archtree-room-audio-cli-test');
        storage = await startLocalS3('room-audio-cli');
        client = new S3Client({ endpoint: storage.endpoint, region: 'us-east-1', forcePathStyle: true,
            credentials: { accessKeyId: 'owned-loopback-fixture', secretAccessKey: 'owned-loopback-fixture-secret' }, maxAttempts: 1 });
        const admin = new ObjectId(), listener = new ObjectId(), mediaTrackId = new ObjectId();
        const key = `audio/${mediaTrackId}/${new ObjectId()}`;
        await getDb()!.collection('users').insertMany([
            { _id: admin, email: 'cli-admin@example.test', role: 'admin' },
            { _id: listener, email: 'cli-listener@example.test', role: 'user' }
        ]);
        await getDb()!.collection('audioTracks').insertOne({ _id: mediaTrackId, title: 'Private fixture title',
            s3Key: key, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready' });
        await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: createPcmWav(1234), ContentType: 'audio/wav' }));
        storage.requests.length = 0;
        const before = await getDb()!.collection('audioTracks').findOne({ _id: mediaTrackId });
        const environment = { ...process.env, AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'owned-loopback-fixture', AWS_SECRET_ACCESS_KEY: 'owned-loopback-fixture-secret',
            S3_BUCKET_NAME: storage.bucket, S3_MAX_ATTEMPTS: '1' };
        delete environment.AWS_SESSION_TOKEN;
        const dryRun = await runCli([`--admin-id=${admin}`], environment);
        assert.equal(dryRun.code, 0);
        assert.equal(dryRun.stderr, '');
        assert.deepEqual(JSON.parse(dryRun.stdout).counts, { wouldAnalyze: 1 });
        assert.equal(storage.requests.length, 0);
        assert.deepEqual(await getDb()!.collection('audioTracks').findOne({ _id: mediaTrackId }), before);
        assert.doesNotMatch(dryRun.stdout, /database_ready|Private fixture title|sourceRevision|attemptId|s3Key/);
        const denied = await runCli([`--admin-id=${listener}`], environment);
        assert.equal(denied.code, 1);
        assert.equal(denied.stdout, '');
        assert.equal(storage.requests.length, 0);
        const applied = await runCli([`--admin-id=${admin}`, '--apply', '--confirm=ANALYZE_ROOM_AUDIO'], environment);
        assert.equal(applied.code, 0);
        assert.equal(applied.stderr, '');
        assert.deepEqual(JSON.parse(applied.stdout).counts, { complete: 1 });
        const stored = await getDb()!.collection('audioTracks').findOne({ _id: mediaTrackId });
        assert.equal(roomAudioRepresentationForTrack(stored)?.durationMs, 1234);
        assert.equal(stored!.s3Key, key);
        assert.ok(storage.requests.length > 0);
        assert.ok(storage.requests.every(value => value.method === 'HEAD' || value.method === 'GET'));
        const requestCount = storage.requests.length;
        const repeated = await runCli([`--admin-id=${admin}`, '--apply', '--confirm=ANALYZE_ROOM_AUDIO'], environment);
        assert.equal(repeated.code, 0);
        assert.deepEqual(JSON.parse(repeated.stdout).counts, { alreadyEligible: 1 });
        assert.equal(storage.requests.length, requestCount);
        assert.deepEqual(await getDb()!.collection('audioTracks').findOne({ _id: mediaTrackId }), stored);
    } finally {
        client?.destroy();
        await storage?.stop();
        await mongo?.stop();
    }
});
