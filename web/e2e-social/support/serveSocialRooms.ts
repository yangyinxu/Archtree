import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDisposableRuntime } from '../../../test/support/disposableRuntime';

const port = Number(process.env.FINITUDE_SOCIAL_E2E_PORT ?? 4175);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid isolated social fixture port.');

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
  { startLocalS3 }, { createPcmWav, wavUploadFile }, { createSocialService }, { default: AuthSession }, { Page }] = await Promise.all([
  import('mongodb'), import('bcryptjs'), import('../../../src/app'), import('../../../src/infrastructure/database'),
  import('../../../src/infrastructure/s3'), import('../../../src/services/audioStorageService'),
  import('../../../src/realtime/roomGateway'), import('../../../src/services/serverLifecycleService'),
  import('../../../test/support/mongoReplicaSet'), import('../../../test/support/localS3'), import('../../../test/support/pcmWav'),
  import('../../../src/application/social/socialService'), import('../../../src/models/authSession'), import('../../../src/models/page')
]);
await runDisposableRuntime(async resources => {
  await resources.own(startMongoReplicaSet('archtree-social-real-browser', { registerSignalHandlers: false }), mongo => mongo.stop());
  const storage = await resources.own(startLocalS3('social-real-browser'), value => value.stop());
  Object.assign(process.env, { AWS_ENDPOINT_URL_S3: storage.endpoint, AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'owned-loopback-fixture', AWS_SECRET_ACCESS_KEY: 'owned-loopback-fixture-secret', S3_BUCKET_NAME: storage.bucket });
  await resources.own(getS3(), client => client.destroy());
  const password = await bcrypt.hash('Social-real-browser-2026!', 10);
  const curator = new ObjectId();
  const listeners = ['listener_one', 'listener_two', 'invitation_host', 'invitation_guest', 'invitation_other']
    .map(username => ({ _id: new ObjectId(), username,
      email: `${username}@example.test`, displayName: username, password, role: 'user', emailVerified: true }));
  await getDb()!.collection('users').insertMany([
    ...listeners,
    { _id: curator, username: 'fixture_curator', email: 'fixture_curator@example.test', password: 'unused-fixture', role: 'admin', emailVerified: true }
  ]);
  await Page.upsertBySlug('home', 'Home', curator.toHexString());
  // Separate invitation-test accounts avoid resets and let the recipient begin on Home with existing friendships.
  const social = createSocialService();
  const invitationPeople = await Promise.all(listeners.filter(value => value.username.startsWith('invitation_')).map(async value => {
    const userId = value._id.toHexString();
    const sessionId = await AuthSession.create(userId, `unused-fixture-${randomUUID()}`, new Date(Date.now() + 3_600_000));
    const actor = { userId, sessionId };
    const scope = await social.issueScope(actor);
    const created = await social.mutate(actor, { scopeToken: scope.scopeToken, commandId: randomUUID(), action: 'profile', expectedRevision: 0,
      handle: value.username, alias: value.username.replace('invitation_', 'Invitation '), discoverable: true });
    const profile = await social.ownProfile(actor);
    if (created.outcome !== 'applied' || !profile) throw new Error('Invitation fixture profile could not be created.');
    return { actor, scope, profile };
  }));
  const guest = invitationPeople.find(value => value.profile.handle === 'invitation_guest')!;
  for (const host of invitationPeople.filter(value => value !== guest)) {
    const requested = await social.mutate(host.actor, { scopeToken: host.scope.scopeToken, commandId: randomUUID(), action: 'request',
      targetSocialId: guest.profile.socialId, expectedRevision: 0 });
    const relation = await social.relationship(guest.actor, host.profile.socialId);
    if (requested.outcome !== 'applied' || !relation) throw new Error('Invitation fixture request could not be created.');
    const accepted = await social.mutate(guest.actor, { scopeToken: guest.scope.scopeToken, commandId: randomUUID(), action: 'accept',
      targetSocialId: host.profile.socialId, expectedRevision: relation.revision });
    if (accepted.outcome !== 'applied') throw new Error('Invitation fixture friendship could not be created.');
  }
  const trackIds: string[] = [];
  const titles = ['First Light', 'Across the Water', 'Home Again'];
  if (process.env.FINITUDE_SOCIAL_E2E_SCENARIO === 'catalog-room') {
    titles.push(...Array.from({ length: 22 }, (_, index) => `Archive song ${String(index + 1).padStart(2, '0')}`));
  }
  for (const [index, title] of titles.entries()) {
    const id = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title, trackNumber: index + 1, artistIds: [],
      duration: '2:00', s3Key: id.toHexString(), mediaType: 'audio', uploadStatus: 'pending', publicationStatus: 'ready',
      createdBy: curator.toHexString(), createdAt: new Date() });
    await uploadAudioObject(id.toHexString(), wavUploadFile(createPcmWav(120_000)), curator.toHexString());
    trackIds.push(id.toHexString());
  }
  if (['music-shares', 'catalog-room'].includes(process.env.FINITUDE_SOCIAL_E2E_SCENARIO ?? '')) {
    // Actual Album publication fences and orders the uploaded tracks; other scenarios retain their original catalog.
    const [{ Album }, { SimpleDate }] = await Promise.all([import('../../../src/models/album'), import('../../../src/models/simpleDate')]);
    await new Album('Shared Horizons', '', trackIds.slice(0, 3) as [string], new SimpleDate(2026, 9, 14), curator.toHexString()).save();
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
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  console.log(`Isolated social browser fixture ready at http://127.0.0.1:${port}/finitude/social`);
}).catch(error => { console.error('The isolated social browser fixture could not start.', error instanceof Error ? error.message : 'Unknown fixture error.'); process.exitCode = 1; });
