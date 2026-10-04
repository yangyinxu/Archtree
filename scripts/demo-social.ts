import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { getS3 } from '../src/infrastructure/s3';
import { uploadAudioObject } from '../src/services/audioStorageService';
import { installRoomGateway } from '../src/realtime/roomGateway';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { runDisposableRuntime } from '../test/support/disposableRuntime';
import { startMongoReplicaSet } from '../test/support/mongoReplicaSet';
import { startLocalS3 } from '../test/support/localS3';
import { createPcmWav, wavUploadFile } from '../test/support/pcmWav';

/** Disposable development demonstration: production routes/players, isolated accounts and real loopback media. */
const main = async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('The social demonstration is local development only.');
    await runDisposableRuntime(async resources => {
        // Keep this demo's lazy chunks stable while another development build replaces web/dist.
        const listenerDistPath = await resources.own(mkdtemp(path.join(tmpdir(), 'archtree-social-demo-web-')),
            directory => rm(directory, { recursive: true, force: true }));
        await cp(path.resolve('web/dist'), listenerDistPath, { recursive: true });
        await resources.own(startMongoReplicaSet('archtree-social-browser-demo', { registerSignalHandlers: false }), mongo => mongo.stop());
        const storage = await resources.own(startLocalS3('room-browser-demo'), value => value.stop());
        process.env.FINITUDE_SOCIAL_ENABLED = 'true';
        process.env.FINITUDE_ROOMS_ENABLED = 'true';
        process.env.ALLOW_LEGACY_AUTH_TOKENS = 'false';
        process.env.ACCESS_TOKEN_MINUTES = '60';
        process.env.AWS_ENDPOINT_URL_S3 = storage.endpoint;
        process.env.AWS_REGION = 'us-east-1';
        process.env.AWS_ACCESS_KEY_ID = 'owned-local-fixture';
        process.env.AWS_SECRET_ACCESS_KEY = 'owned-local-fixture-secret';
        delete process.env.AWS_SESSION_TOKEN;
        process.env.S3_BUCKET_NAME = storage.bucket;
        await resources.own(getS3(), client => client.destroy());
        const password = await bcrypt.hash('Social-demo-only-2026!', 12);
        const curator = new ObjectId();
        await getDb()!.collection('users').insertMany([
            { _id: new ObjectId(), username: 'alice', email: 'alice@example.test', displayName: 'Alice', password, role: 'user', emailVerified: true },
            { _id: new ObjectId(), username: 'bob', email: 'bob@example.test', displayName: 'Bob', password, role: 'user', emailVerified: true },
            { _id: curator, username: 'demo-curator', email: 'curator@example.test', password: 'unused-demo-curator', role: 'admin', emailVerified: true }
        ]);
        await getDb()!.collection('pages').insertOne({ slug: 'home', title: 'Welcome to Finitude', items: [], createdBy: curator.toHexString() });
        for (const [index, title] of ['First Light', 'Across the Water', 'Home Again'].entries()) {
            const id = new ObjectId();
            const durationMs = 120_000;
            const bytes = createPcmWav(durationMs);
            const notes = [[261.63, 329.63, 392, 523.25], [293.66, 349.23, 440, 587.33], [220, 261.63, 329.63, 440]][index];
            // Original synthesized notes make each queue transition audible without external copyrighted media.
            for (let sample = 0; sample < durationMs * 16; sample++) {
                const time = sample / 16000;
                const beat = time % 0.6;
                const amplitude = Math.min(1, beat * 40) * Math.exp(-beat * 5) * 0.1;
                const frequency = notes[Math.floor(time / 0.6) % notes.length];
                bytes.writeInt16LE(Math.round(Math.sin(time * frequency * Math.PI * 2) * amplitude * 32767), 44 + sample * 2);
            }
            await getDb()!.collection('audioTracks').insertOne({ _id: id, title, trackNumber: index + 1, artistIds: [],
                duration: '2:00', s3Key: id.toHexString(), mediaType: 'audio', uploadStatus: 'pending',
                publicationStatus: 'ready', createdBy: curator.toHexString(), createdAt: new Date() });
            await uploadAudioObject(id.toHexString(), wavUploadFile(bytes), curator.toHexString());
        }
        const lifecycle = new ServerLifecycle();
        const server = createServer(createApp({ lifecycle, environment: 'test', listenerDistPath }));
        await resources.own(installRoomGateway(server, lifecycle), async gateway => { gateway.stop(); await gateway.release(); });
        await resources.own(server, async value => {
            if (await lifecycle.stop(value, async () => {}, 5_000, 10_000) !== 'graceful') throw new Error('Demo server drain failed.');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Demo listener failed.');
        const urls = { alice: `http://127.0.0.1:${address.port}/finitude/social`, bob: `http://localhost:${address.port}/finitude/social` };
        // Only non-secret origins are emitted; login uses normal product authentication with synthetic fixtures.
        const urlsPath = path.join(tmpdir(), 'archtree-social-demo-urls.json');
        const urlsText = JSON.stringify(urls);
        await resources.own(writeFile(urlsPath, urlsText).then(() => urlsPath), async filename => {
            // Another running demo may have published a newer pointer; never remove its file.
            if (await readFile(filename, 'utf8').catch(() => '') === urlsText) await rm(filename, { force: true });
        });
        console.log(JSON.stringify({ category: 'social_demo_ready', ...urls }));
    });
};
void main().catch(() => { console.error('The isolated social demonstration could not start.'); process.exitCode = 1; });
