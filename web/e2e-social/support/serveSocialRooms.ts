import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { RoomDocument } from '../../../src/repositories/social/roomDocuments';
import { runDisposableRuntime } from '../../../test/support/disposableRuntime';
import { readRoomSoakOptions } from './roomSoakPolicy';
import { startFixtureShutdown } from './fixtureShutdown';

const port = Number(process.env.FINITUDE_SOCIAL_E2E_PORT ?? 4175);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid isolated social fixture port.');
const soak = process.env.FINITUDE_SOCIAL_E2E_SCENARIO === 'soak' ? readRoomSoakOptions() : undefined;
// Only the room-lifecycle scenario may age a recorded host absence; every other scenario keeps real time alone.
const lifecycleScenario = process.env.FINITUDE_SOCIAL_E2E_SCENARIO === 'room-lifecycle';
const soakNames = ['listener_one', 'listener_two', 'listener_three', 'listener_four', 'listener_five', 'listener_six', 'listener_seven', 'listener_eight'];

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
  const listeners = [...(soak ? soakNames.slice(0, soak.members) : soakNames.slice(0, 2)), 'invitation_host', 'invitation_guest', 'invitation_other']
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
  if (soak) {
    // Provision only synthetic identities; browser commands still perform real invitations and admission.
    const people = [];
    for (const [index, value] of listeners.filter(value => value.username.startsWith('listener_')).entries()) {
      const userId = value._id.toHexString();
      const sessionId = await AuthSession.create(userId, `unused-fixture-${randomUUID()}`, new Date(Date.now() + 86_400_000));
      const actor = { userId, sessionId };
      const scope = await social.issueScope(actor);
      const created = await social.mutate(actor, { scopeToken: scope.scopeToken, commandId: randomUUID(), action: 'profile', expectedRevision: 0,
        handle: value.username, alias: `Soak Listener ${index + 1}`, discoverable: true });
      const profile = await social.ownProfile(actor);
      if (created.outcome !== 'applied' || !profile) throw new Error('Soak fixture profile could not be created.');
      people.push({ actor, scope, profile });
    }
    const host = people[0];
    for (const friend of people.slice(1)) {
      const requested = await social.mutate(host.actor, { scopeToken: host.scope.scopeToken, commandId: randomUUID(), action: 'request',
        targetSocialId: friend.profile.socialId, expectedRevision: 0 });
      const relation = await social.relationship(friend.actor, host.profile.socialId);
      if (requested.outcome !== 'applied' || !relation) throw new Error('Soak fixture friendship could not be read.');
      const accepted = await social.mutate(friend.actor, { scopeToken: friend.scope.scopeToken, commandId: randomUUID(), action: 'accept',
        targetSocialId: host.profile.socialId, expectedRevision: relation.revision });
      if (accepted.outcome !== 'applied') throw new Error('Soak fixture friendship could not be created.');
    }
  }
  const trackIds: string[] = [];
  const compressedAudio = process.env.FINITUDE_SOCIAL_E2E_SCENARIO === 'audio-formats';
  const titles = compressedAudio ? ['MP3 Horizon', 'AAC Horizon', 'VBR MP3 Horizon'] : ['First Light', 'Across the Water', 'Home Again'];
  if (process.env.FINITUDE_SOCIAL_E2E_SCENARIO === 'catalog-room') {
    titles.push(...Array.from({ length: 22 }, (_, index) => `Archive song ${String(index + 1).padStart(2, '0')}`));
  }
  for (const [index, title] of titles.entries()) {
    const id = new ObjectId();
    // Endurance selection repeats every three cycles; ordinary short fixtures retain their real end boundaries.
    const durationSeconds = soak ? Math.max(120, soak.cycleSeconds * 3 + 60) : 120;
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title, trackNumber: index + 1, artistIds: [],
      duration: `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`, s3Key: id.toHexString(), mediaType: 'audio', uploadStatus: 'pending', publicationStatus: 'ready',
      createdBy: curator.toHexString(), createdAt: new Date() });
    // The dedicated format gate publishes the original compressed bytes through the same storage lifecycle as uploads.
    let upload = wavUploadFile(createPcmWav(durationSeconds * 1000));
    if (compressedAudio) {
      const filename = ['room-tone.mp3', 'room-tone.m4a', 'room-tone-vbr.mp3'][index];
      const buffer = await readFile(new URL(`../../../test/fixtures/room-audio/${filename}`, import.meta.url));
      // An incorrect client MIME cannot override the AAC container verified from its actual bytes.
      upload = { ...upload, originalname: filename, mimetype: filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
        buffer, size: buffer.length };
    }
    await uploadAudioObject(id.toHexString(), upload, curator.toHexString());
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
  const app = createApp({ lifecycle, environment: 'test', listenerDistPath });
  const transports = new Set<Socket>();
  const upgrades = new Set<Socket>();
  const { getMediaDeliveryMetrics } = await import('../../../src/services/mediaDeliveryService');
  const { defaultMediaAdmissionController } = await import('../../../src/middleware/mediaDeliveryMiddleware');
  /**
   * Records that the single open room's host absence began `elapsedMs` ago, so the 30-second and
   * five-minute boundaries are reachable within a browser test. It changes no limit, timer or snapshot:
   * the application's own sweep still decides suspension or closure and publishes the result.
   */
  const ageHostAbsence = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > 256) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let elapsedMs: unknown;
    try { elapsedMs = JSON.parse(Buffer.concat(chunks).toString('utf8')).elapsedMs; } catch { elapsedMs = undefined; }
    if (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 600_000) {
      res.writeHead(400).end(); return;
    }
    const rooms = getDb()!.collection<RoomDocument>('socialRooms');
    const absent = await rooms.find({ state: 'open', hostAbsentSince: { $ne: null } }).project<Pick<RoomDocument, '_id' | 'hostMembershipId'>>(
      { _id: 1, hostMembershipId: 1 }).limit(2).toArray();
    if (absent.length !== 1) { res.writeHead(409).end(); return; }
    const [{ _id, hostMembershipId }] = absent;
    const since = new Date(Date.now() - elapsedMs);
    // Absence starts at the host's last confirmed heartbeat, so both move together; a reconnected host is never aged.
    const result = await rooms.updateOne({ _id, state: 'open', hostMembershipId, hostAbsentSince: { $ne: null },
      members: { $elemMatch: { membershipId: hostMembershipId, connectionPresent: false } } },
    { $set: { hostAbsentSince: since, 'members.$[host].lastSeenAt': since } }, { arrayFilters: [{ 'host.membershipId': hostMembershipId }] });
    res.writeHead(result.modifiedCount === 1 ? 204 : 409, { 'Cache-Control': 'no-store' }).end();
  };
  const server = createServer((req, res) => {
    // This disposable-fixture endpoint, like the soak endpoint below, never exists in the application.
    if (lifecycleScenario && req.method === 'POST' && req.url === '/__fixture/room-host-absence') {
      ageHostAbsence(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    // This aggregate-only endpoint exists exclusively in the disposable soak fixture, never the application.
    if (soak && req.method === 'GET' && req.url === '/__fixture/room-soak-resources') {
      // Fixture request evidence must not masquerade as application memory growth during a long run.
      if (storage.requests.length > 64) storage.requests.splice(0, storage.requests.length - 64);
      const memory = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        activeUpgradeTransports: upgrades.size, activeStreams: getMediaDeliveryMetrics().activeRequests,
        queuedPlaybackRequests: defaultMediaAdmissionController.getQueuedPlaybackRequests(),
        activeTcpTransports: transports.size, retainedStorageRequests: storage.requests.length }));
      return;
    }
    app(req, res);
  });
  if (soak) {
    server.on('connection', socket => { transports.add(socket); socket.once('close', () => transports.delete(socket)); });
    server.on('upgrade', (_req, socket) => {
      const transport = socket as Socket;
      upgrades.add(transport); transport.once('close', () => upgrades.delete(transport));
    });
  }
  await resources.own(installRoomGateway(server, lifecycle), async gateway => { gateway.stop(); await gateway.release(); });
  await resources.own(server, async value => {
    if (await lifecycle.stop(value, async () => {}, 5000, 10_000) !== 'graceful') throw new Error('Fixture server drain failed.');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  if (soak) {
    await resources.own(startFixtureShutdown(4188, process.env.FINITUDE_ROOM_SOAK_STOP_TOKEN ?? '', () => resources.close()),
      control => control.stopAccepting());
  }
  console.log(`Isolated social browser fixture ready at http://127.0.0.1:${port}/finitude/social`);
}).catch(error => { console.error('The isolated social browser fixture could not start.', error instanceof Error ? error.message : 'Unknown fixture error.'); process.exitCode = 1; });
