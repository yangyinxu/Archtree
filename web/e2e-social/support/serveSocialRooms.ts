import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDisposableRuntime } from '../../../test/support/disposableRuntime';

// This process never connects to a developer database or external object store.
for (const key of Object.keys(process.env)) {
  if (/^(AWS_|DB_|S3_)/.test(key) || ['JWT_SECRET', 'AUTH_CODE_PEPPER', 'AUTH_EMAIL_FROM'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: fileURLToPath(new URL('../../e2e/support/empty.env', import.meta.url)),
  JWT_SECRET: 'social-real-browser-fixture', AUTH_CODE_PEPPER: 'social-real-browser-fixture',
  FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: 'true', ALLOW_LEGACY_AUTH_TOKENS: 'false'
});
const [{ ObjectId }, { default: bcrypt }, { createApp }, { getDb }, { getS3 }, { uploadAudioObject },
  { installRoomGateway }, { ServerLifecycle }, { startMongoReplicaSet },
  { startLocalS3 }, { createPcmWav, wavUploadFile }] = await Promise.all([
  import('mongodb'), import('bcryptjs'), import('../../../src/app'), import('../../../src/infrastructure/database'),
  import('../../../src/infrastructure/s3'), import('../../../src/services/audioStorageService'),
  import('../../../src/realtime/roomGateway'), import('../../../src/services/serverLifecycleService'),
  import('../../../test/support/mongoReplicaSet'), import('../../../test/support/localS3'), import('../../../test/support/pcmWav')
]);
await runDisposableRuntime(async resources => {
  await resources.own(startMongoReplicaSet('archtree-social-real-browser', { registerSignalHandlers: false }), mongo => mongo.stop());
  const storage = await resources.own(startLocalS3('social-real-browser'), value => value.stop());
  Object.assign(process.env, { AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'owned-loopback-fixture', AWS_SECRET_ACCESS_KEY: 'owned-loopback-fixture-secret', S3_BUCKET_NAME: storage.bucket });
  await resources.own(getS3(), client => client.destroy());
  const password = await bcrypt.hash('Social-real-browser-2026!', 10);
  const curator = new ObjectId();
  await getDb()!.collection('users').insertMany([
    ...['listener_one', 'listener_two'].map(username => ({ _id: new ObjectId(), username,
      email: `${username}@example.test`, displayName: username, password, role: 'user', emailVerified: true })),
    { _id: curator, username: 'fixture_curator', email: 'fixture_curator@example.test', password: 'unused-fixture', role: 'admin', emailVerified: true }
  ]);
  for (const [index, title] of ['First Light', 'Across the Water', 'Home Again'].entries()) {
    const id = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title, trackNumber: index + 1, artistIds: [],
      duration: '2:00', s3Key: id.toHexString(), mediaType: 'audio', uploadStatus: 'pending', publicationStatus: 'ready',
      createdBy: curator.toHexString(), createdAt: new Date() });
    await uploadAudioObject(id.toHexString(), wavUploadFile(createPcmWav(120_000)), curator.toHexString());
  }
  const lifecycle = new ServerLifecycle();
  const listenerDistPath = await resources.own(mkdtemp(join(tmpdir(), 'archtree-social-e2e-dist-')),
    directory => rm(directory, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('../../dist', import.meta.url)), listenerDistPath, { recursive: true });
  const server = createServer(createApp({ lifecycle, environment: 'test', listenerDistPath }));
  await resources.own(installRoomGateway(server, lifecycle), async gateway => { gateway.stop(); await gateway.release(); });
  await resources.own(server, async value => {
    if (await lifecycle.stop(value, async () => {}, 5000, 10_000) !== 'graceful') throw new Error('Fixture server drain failed.');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4175, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  console.log('Isolated social browser fixture ready at http://127.0.0.1:4175/finitude/social');
}).catch(() => { console.error('The isolated social browser fixture could not start.'); process.exitCode = 1; });
