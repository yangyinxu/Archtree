import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { MongoServerError, ObjectId } from 'mongodb';
import { createSocialService, type SocialServiceOptions } from '../src/application/social/socialService';
import { createRoomService } from '../src/application/rooms/roomService';
import { cleanupListeningForContent } from '../src/application/social/listeningLifecycle';
import { LISTENING_LIMITS, type ListeningReport, type ListeningPlayback } from '../src/contracts/listeningV1';
import { SocialError, type SocialActor, type SocialApi, type SocialScope } from '../src/contracts/socialV1';
import type { RoomCommand } from '../src/contracts/roomV1';
import { getDb } from '../src/infrastructure/database';
import type { ListeningPublicationDocument, ListeningStateDocument } from '../src/repositories/social/listeningDocuments';
import AuthSession from '../src/models/authSession';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { updateMediaTrackStorageState } from '../src/services/mediaRepresentationLifecycleService';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import { roomAuthority } from '../src/realtime/roomAuthority';
import { onRoomChanges } from '../src/realtime/roomEvents';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
let now = Date.now(); let enabled = true; let api: SocialApi; let tracks: string[];
const db = () => getDb()!;
const states = () => db().collection<ListeningStateDocument>('socialListeningStates');
const publications = () => db().collection<ListeningPublicationDocument>('socialListeningPublications');
const secret = 'synthetic-listening-test-secret';
const service = (options: SocialServiceOptions = {}) => createSocialService({ now: () => now, enabled: () => enabled,
    secret: () => secret, listeningRoomsEnabled: () => true, ...options });
before(async () => { harness = await startMongoReplicaSet('archtree-listening-test'); });
beforeEach(async () => {
    now = Date.now(); enabled = true;
    for (const name of ['users', 'authSessions', 'socialProfiles', 'socialRelationships', 'socialMusicShares', 'socialMutations', 'socialBudgets',
        'socialOutbox', 'socialHandles', 'audioTracks', 'albums', 'socialRooms', 'socialInvitations', 'socialRoomParticipation', 'socialRoomOutbox',
        'socialListeningStates', 'socialListeningPublications', 'socialAuthority']) await db().collection(name).deleteMany({});
    tracks = Array.from({ length: 3 }, () => new ObjectId().toHexString());
    await db().collection('audioTracks').insertMany(tracks.map((id, index) => ({ _id: new ObjectId(id), title: `Public Audio ${index}`,
        s3Key: id, mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready', duration: '2:00', coverArtUrl: '/art.jpg' })));
    api = service();
});
after(async () => { await harness?.stop(); });
const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const person = async (name: string) => {
    const id = new ObjectId(); await db().collection('users').insertOne({ _id: id, username: `Private ${name}`, email: `${name}@private.invalid`, role: 'user' });
    const actor: SocialActor = { userId: id.toHexString(), sessionId: await AuthSession.create(id.toHexString(), randomUUID(), new Date(now + 90 * 86_400_000)) };
    const scope = await api.issueScope(actor);
    assert.equal((await api.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0, handle: name,
        alias: `Public ${name}`, discoverable: true })).outcome, 'applied');
    return { actor, scope, clientId: randomUUID(), profile: (await api.ownProfile(actor))! };
};
type Person = Awaited<ReturnType<typeof person>>;
const friends = async (a: Person, b: Person) => {
    await api.mutate(a.actor, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId,
        expectedRevision: (await api.relationship(a.actor, b.profile.socialId))?.revision ?? 0 });
    await api.mutate(b.actor, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId,
        expectedRevision: (await api.relationship(b.actor, a.profile.socialId))!.revision });
};
const pair = async () => { const a = await person('alice'); const b = await person('bobby'); await friends(a, b); return { a, b }; };
const preference = async (who: Person, value = true, target = api) => target.mutate(who.actor, { ...identity(who.scope), action: 'setListeningSharing',
    enabled: value, expectedRevision: (await target.ownListening(who.actor)).revision });
const claimIntent = async (who: Person, target = api) => {
    const state = await target.ownListening(who.actor);
    return { ...identity(who.scope), action: 'claimListening' as const, clientId: who.clientId,
        expectedPreferenceRevision: state.revision, expectedPublisherRevision: state.publisherRevision };
};
const claim = async (who: Person, target = api) => {
    const intent = await claimIntent(who, target); assert.equal((await target.mutate(who.actor, intent)).outcome, 'applied');
    return { clientId: who.clientId, publicationId: intent.commandId, expectedPreferenceRevision: intent.expectedPreferenceRevision,
        expectedPublisherRevision: intent.expectedPublisherRevision + 1, sequence: 0 };
};
type Publisher = Awaited<ReturnType<typeof claim>>;
const playback = (mediaTrackId = tracks[0]): ListeningPlayback => ({ sourceId: randomUUID(), occurrenceId: randomUUID(), mediaTrackId, positionMs: 500, room: null });
const capturedPlaying = new WeakMap<Publisher, Map<string, number>>();
const playing = (publisher: Publisher, value: ListeningPlayback, sequence = ++publisher.sequence): ListeningReport => {
    const occurrences = capturedPlaying.get(publisher) ?? new Map<string, number>(); occurrences.set(value.occurrenceId, sequence); capturedPlaying.set(publisher, occurrences);
    return { ...publisher, sequence, state: 'playing', observedAtMs: now, playback: value };
};
const stopped = (publisher: Publisher, occurrenceId: string, sequence = ++publisher.sequence): ListeningReport => ({ ...publisher,
    sequence, state: 'stopped', occurrenceId, playbackSequence: capturedPlaying.get(publisher)!.get(occurrenceId)! });
const begin = async (who: Person) => {
    assert.equal((await preference(who)).outcome, 'applied'); const publisher = await claim(who); const value = playback();
    assert.equal((await api.reportListening(who.actor, playing(publisher, value))).accepted, true); return { publisher, value };
};
const status = (viewer: Person, publisher: Person, target = api) => target.listeningStatuses(viewer.actor, [publisher.profile.socialId]);
const isError = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;

test('default-off ordinary Audio publication is private, minimal and silent until an actual report, with no generic invalidation', async () => {
    const { a, b } = await pair(); const outsider = await person('outsider');
    assert.deepEqual(await api.ownListening(a.actor), { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: now });
    assert.equal(await states().countDocuments({}), 0);
    assert.equal((await api.mutate(a.actor, { ...identity(a.scope), action: 'claimListening', clientId: a.clientId,
        expectedPreferenceRevision: 1, expectedPublisherRevision: 0 })).code, 'listening_disabled');
    const outboxes = await db().collection('socialOutbox').find({}).sort({ _id: 1 }).toArray(); let wakeups = 0;
    const unsubscribe = onRoomChanges(() => { wakeups += 1; });
    try {
        await preference(a); const publisher = await claim(a); assert.deepEqual(await status(b, a), []);
        const value = playback(); assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, true);
        const visible = await status(b, a); assert.equal(visible.length, 1); assert.equal(visible[0].track.title, 'Public Audio 0');
        assert.deepEqual(Object.keys(visible[0]).sort(), ['expiresAtMs', 'peer', 'track']);
        assert.deepEqual(Object.keys(visible[0].track).sort(), ['artistNames', 'artworkUrl', 'contentType', 'id', 'title']);
        for (const privateValue of [a.actor.userId, a.actor.sessionId, a.clientId, publisher.publicationId, value.sourceId, value.occurrenceId, 'positionMs', 's3Key']) {
            assert.equal(JSON.stringify(visible).includes(privateValue), false);
        }
        assert.deepEqual(await status(outsider, a), []); assert.deepEqual(await status(a, a), []);
        await api.reportListening(a.actor, stopped(publisher, value.occurrenceId)); assert.deepEqual(await status(b, a), []);
        assert.deepEqual(await db().collection('socialOutbox').find({}).sort({ _id: 1 }).toArray(), outboxes); assert.equal(wakeups, 0);
    } finally { unsubscribe(); }
});

test('preference and publisher clocks survive explicit opt-out, disabled participation and receipt replay', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    const state = await api.ownListening(a.actor); enabled = false;
    assert.deepEqual(await status(b, a), []);
    await assert.rejects(api.mutate(a.actor, await claimIntent(a)), isError('social_disabled'));
    await assert.rejects(api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 1500 })), isError('social_disabled'));
    assert.equal((await api.reportListening(a.actor, stopped(publisher, value.occurrenceId))).accepted, true);
    const optOut = { ...identity(a.scope), action: 'setListeningSharing' as const, enabled: false, expectedRevision: state.revision };
    assert.equal((await api.mutate(a.actor, optOut)).outcome, 'applied'); assert.equal((await api.mutate(a.actor, optOut)).replayed, true);
    const off = await api.ownListening(a.actor); assert.equal(off.enabled, false); assert.equal(off.publisherRevision, state.publisherRevision + 1);
    assert.equal(await publications().countDocuments({}), 0);
    enabled = true; assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, false);
    assert.equal((await api.mutate(a.actor, { ...identity(a.scope), action: 'setListeningSharing', enabled: true, expectedRevision: state.revision })).code, 'listening_preference_changed');
    assert.deepEqual(await status(b, a), []);
});

test('competing explicit device claims commit one owner and old devices cannot publish or stop newer playback', async () => {
    const { a, b } = await pair(); await preference(a);
    const other = { ...a, clientId: randomUUID(), actor: { ...a.actor, sessionId: await AuthSession.create(a.actor.userId, randomUUID(), new Date(now + 60_000)) } };
    const first = await claimIntent(a); const second = await claimIntent(other);
    const results = await Promise.all([api.mutate(a.actor, first), api.mutate(other.actor, second)]);
    assert.equal(results.filter(result => result.outcome === 'applied').length, 1); assert.equal(results.filter(result => result.code === 'listening_publisher_changed').length, 1);
    const winner = results[0].outcome === 'applied' ? a : other; const won = results[0].outcome === 'applied' ? first : second;
    const old: Publisher = { clientId: winner.clientId, publicationId: won.commandId, expectedPreferenceRevision: won.expectedPreferenceRevision,
        expectedPublisherRevision: won.expectedPublisherRevision + 1, sequence: 0 };
    const oldValue = playback(); await api.reportListening(winner.actor, playing(old, oldValue));
    const fresh = await claim(other); const freshValue = playback(tracks[1]); await api.reportListening(other.actor, playing(fresh, freshValue));
    assert.equal((await api.reportListening(winner.actor, stopped(old, oldValue.occurrenceId))).accepted, false);
    assert.equal((await api.reportListening(winner.actor, playing(old, { ...oldValue, positionMs: 2000 }))).accepted, false);
    assert.equal((await status(b, a))[0].track.id, tracks[1]);
});

test('unknown claim commit retains one private owner and original status-only receipt without automatic replay', async () => {
    const { a, b } = await pair(); await preference(a); const intent = await claimIntent(a); let commits = 0;
    const uncertain = service({ beforeCommit: async session => {
        commits += 1; await session.commitTransaction(); const error = new MongoServerError({ message: 'synthetic lost claim acknowledgement' });
        error.addErrorLabel('UnknownTransactionCommitResult'); error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    await assert.rejects(uncertain.mutate(a.actor, intent), isError('mutation_outcome_unknown')); assert.equal(commits, 1);
    assert.deepEqual(await api.outcome(a.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }),
        { commandId: intent.commandId, outcome: 'applied', replayed: true });
    const state = await api.ownListening(a.actor); assert.equal(state.publisherRevision, intent.expectedPublisherRevision + 1);
    assert.equal((await api.mutate(a.actor, intent)).replayed, true); assert.equal(await publications().countDocuments({}), 1);
    assert.deepEqual(await status(b, a), []);
    now += LISTENING_LIMITS.freshnessMs;
    const owner = { clientId: a.clientId, publicationId: intent.commandId, expectedPreferenceRevision: state.revision,
        expectedPublisherRevision: state.publisherRevision, sequence: 0 };
    assert.equal((await api.reportListening(a.actor, playing(owner, playback()))).accepted, false);
    assert.equal((await api.mutate(a.actor, intent)).replayed, true); assert.equal((await api.ownListening(a.actor)).publisherRevision, state.publisherRevision);
    await publications().deleteMany({}); assert.equal((await api.reportListening(a.actor, playing(owner, playback()))).accepted, false);
    assert.equal(await publications().countDocuments({}), 0);
});

test('fresh progressing observations renew at most once per ten seconds and stalled or delayed reports never extend expiry', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    const initialExpiry = (await status(b, a))[0].expiresAtMs;
    now += 1_000; assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 1_500 }))).expiresAtMs, initialExpiry);
    now += 9_000; assert.equal((await api.reportListening(a.actor, playing(publisher, value))).expiresAtMs, initialExpiry);
    const report = playing(publisher, { ...value, positionMs: 10_500 });
    assert.equal((await api.reportListening(a.actor, { ...report, observedAtMs: now - 5_001 })).accepted, false);
    assert.equal((await api.reportListening(a.actor, { ...report, observedAtMs: now + 2_001 })).accepted, false);
    assert.equal((await api.reportListening(a.actor, report)).expiresAtMs, now + LISTENING_LIMITS.freshnessMs);
    const renewed = (await status(b, a))[0].expiresAtMs; now += 10_000;
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 10_500 }))).expiresAtMs, renewed);
    now = renewed; assert.deepEqual(await status(b, a), []);
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 30_000 }))).accepted, false);
    assert.equal(await publications().countDocuments({}), 1, 'Logical expiry must not rely on TTL having run.');
});

test('exact safety stops survive exhausted playing budget and do not clear a different actual-run occurrence', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    await db().collection('socialBudgets').updateOne({ _id: a.actor.userId }, { $set: { listeningReportMinute: Math.floor(now / 60_000), listeningReports: 60 } });
    await assert.rejects(api.reportListening(a.actor, playing(publisher, value)), isError('listening_report_limit'));
    const stop = stopped(publisher, value.occurrenceId); assert.equal((await api.reportListening(a.actor, stop)).accepted, true);
    const persisted = await publications().findOne({ _id: a.actor.userId });
    assert.equal((await api.reportListening(a.actor, stop)).accepted, false); assert.deepEqual(await publications().findOne({ _id: a.actor.userId }), persisted);
    assert.deepEqual(await status(b, a), []);
    await db().collection('socialBudgets').updateOne({ _id: a.actor.userId }, { $set: { listeningReports: 0 } });
    const resumed = { ...value, occurrenceId: randomUUID(), positionMs: 1_000 };
    assert.equal((await api.reportListening(a.actor, playing(publisher, resumed))).accepted, true);
    assert.equal((await api.reportListening(a.actor, stopped(publisher, value.occurrenceId))).accepted, true);
    assert.equal((await status(b, a)).length, 1);
});

test('stop received before an in-flight first playing report fences its sequence without publishing an empty claim', async () => {
    const { a, b } = await pair(); await preference(a); const publisher = await claim(a); const value = playback();
    const delayed = playing(publisher, value); const stop = stopped(publisher, value.occurrenceId);
    assert.equal((await api.reportListening(a.actor, stop)).accepted, true);
    assert.equal((await api.reportListening(a.actor, delayed)).accepted, false);
    assert.deepEqual(await status(b, a), []);
    assert.equal((await publications().findOne({ _id: a.actor.userId }))?.playback, null);
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, occurrenceId: randomUUID(), positionMs: 1_500 }))).accepted, true);
});

test('a later run stop overtaking both its playing and the previous stop cannot resurrect either run', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    const oldStop = stopped(publisher, value.occurrenceId);
    const nextValue = { ...value, occurrenceId: randomUUID(), positionMs: 1000 };
    const delayedPlaying = playing(publisher, nextValue); const nextStop = stopped(publisher, nextValue.occurrenceId);
    assert.equal((await api.reportListening(a.actor, nextStop)).accepted, true);
    assert.deepEqual(await status(b, a), []);
    assert.equal((await api.reportListening(a.actor, oldStop)).accepted, false);
    assert.equal((await api.reportListening(a.actor, delayedPlaying)).accepted, false);
    assert.deepEqual(await status(b, a), []);
    assert.equal((await publications().findOne({ _id: a.actor.userId }))?.blockedOccurrenceId, nextValue.occurrenceId);
});

test('opt-out retains reserved receipt capacity after admission receipts are full', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    const existing = await db().collection('socialMutations').countDocuments({ accountId: a.actor.userId });
    await db().collection('socialMutations').insertMany(Array.from({ length: 1000 - existing }, () => ({
        _id: randomUUID(), accountId: a.actor.userId, scopeId: randomUUID(), commandId: randomUUID(), expiresAt: new Date(now + 86_400_000)
    })));
    enabled = false;
    assert.equal((await preference(a, false)).outcome, 'applied');
    assert.equal(await publications().countDocuments({ _id: a.actor.userId }), 0); assert.deepEqual(await status(b, a), []);
    assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, false);
});

test('replaced ordinary source is hidden immediately and the same loaded source cannot rebind on resume', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    await api.reportListening(a.actor, stopped(publisher, value.occurrenceId));
    const key = `audio/${tracks[0]}/${new ObjectId().toHexString()}`;
    await updateMediaTrackStorageState(tracks[0], { uploadStatus: 'ready', s3Key: tracks[0] }, { s3Key: key });
    assert.deepEqual(await status(b, a), []);
    const oldRevision = (await api.ownListening(a.actor)).publisherRevision;
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, occurrenceId: randomUUID(), positionMs: 1_000 }))).accepted, false);
    assert.equal(await publications().countDocuments({}), 0); assert.equal((await api.ownListening(a.actor)).publisherRevision, oldRevision + 1);
    const fresh = await claim(a); assert.equal((await api.reportListening(a.actor, playing(fresh, playback()))).accepted, true);
    assert.equal((await status(b, a))[0].track.id, tracks[0]);
});

for (const action of ['remove', 'block', 'deactivate', 'delete'] as const) {
    test(`${action} removes friend visibility and account cleanup never restores a former publication`, async () => {
        const { a, b } = await pair(); const { publisher, value } = await begin(a);
        if (action === 'remove') await api.mutate(b.actor, { ...identity(b.scope), action, targetSocialId: a.profile.socialId,
            expectedRevision: (await api.relationship(b.actor, a.profile.socialId))!.revision });
        else if (action === 'block') await api.mutate(b.actor, { ...identity(b.scope), action, targetSocialId: a.profile.socialId });
        else if (action === 'deactivate') {
            await api.mutate(a.actor, { ...identity(a.scope), action });
            const current = (await api.ownProfile(a.actor))!;
            await api.mutate(a.actor, { ...identity(a.scope), action: 'profile', expectedRevision: current.revision,
                handle: current.handle, alias: current.alias, discoverable: true });
            assert.equal((await api.ownListening(a.actor)).enabled, false);
            assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, false);
        } else {
            const before = await publications().findOne({ _id: a.actor.userId });
            await assert.rejects(deleteListenerAccountData(a.actor.userId, { afterSocialCleanup: async () => { throw new Error('synthetic cleanup rollback'); } }), /synthetic cleanup rollback/);
            assert.deepEqual(await publications().findOne({ _id: a.actor.userId }), before);
            assert.equal((await deleteListenerAccountData(a.actor.userId)).status, 'deleted');
            assert.equal(await publications().countDocuments({ _id: a.actor.userId }), 0); assert.equal(await states().countDocuments({ _id: a.actor.userId }), 0);
            await assert.rejects(api.reportListening(a.actor, playing(publisher, value)), isError('social_session_required'));
        }
        assert.deepEqual(await status(b, a), []);
    });
}

test('current public metadata is resolved on every read while unavailable, Video and failed reads expose no retained card', async () => {
    const { a, b } = await pair(); await begin(a);
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(tracks[0]) }, { $set: { title: 'Fresh current title' } });
    assert.equal((await status(b, a))[0].track.title, 'Fresh current title');
    const profile = (await api.ownProfile(a.actor))!;
    await api.mutate(a.actor, { ...identity(a.scope), action: 'profile', expectedRevision: profile.revision,
        handle: profile.handle, alias: 'Current alias', discoverable: false });
    assert.equal((await status(b, a))[0].peer.alias, 'Current alias');
    assert.deepEqual(await status(b, a, service({ resolveListeningContent: async () => null })), []);
    await assert.rejects(status(b, a, service({ resolveListeningContent: async () => { throw new Error('synthetic unavailable catalog'); } })), isError('social_unavailable'));
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(tracks[0]) }, { $set: { mediaType: 'video', s3Key: `video/${tracks[0]}/${new ObjectId()}` } });
    assert.deepEqual(await status(b, a), []);
});

test('session revocation clears ordinary publishers outside rooms and password retention preserves only the kept session', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a);
    const otherId = await AuthSession.create(a.actor.userId, randomUUID(), new Date(now + 90_000));
    assert.equal(await db().collection('socialRooms').countDocuments({}), 0);
    await AuthSession.revokeAllExcept(a.actor.userId, a.actor.sessionId);
    assert.equal((await status(b, a)).length, 1); assert.ok((await db().collection('authSessions').findOne({ _id: new ObjectId(otherId) }))?.revokedAt);
    const kept = await AuthSession.create(a.actor.userId, randomUUID(), new Date(now + 90_000));
    await AuthSession.revokeAllExcept(a.actor.userId, kept);
    assert.deepEqual(await status(b, a), []); assert.equal(await publications().countDocuments({}), 0);
    await assert.rejects(api.reportListening(a.actor, playing(publisher, value)), isError('social_session_required'));
    const replacement = { ...a, actor: { ...a.actor, sessionId: kept } }; const fresh = await claim(replacement);
    await api.reportListening(replacement.actor, playing(fresh, playback()));
    await AuthSession.revokeById(a.actor.userId, kept); assert.deepEqual(await status(b, a), []); assert.equal(await publications().countDocuments({}), 0);
});

test('source deletion winning a playing report retires its stale lease and bounded content cleanup removes all matching references', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a); let removed = false;
    const racing = service({ beforeAccountFence: async () => {
        if (removed) return; removed = true;
        await updateMediaTrackStorageState(tracks[0], { uploadStatus: 'ready' }, { uploadStatus: 'deleting' });
    } });
    now += LISTENING_LIMITS.renewMs;
    assert.equal((await racing.reportListening(a.actor, playing(publisher, { ...value, positionMs: 10_000 }))).accepted, false);
    assert.deepEqual(await status(b, a), []); assert.equal(await publications().countDocuments({}), 0);
    const template: ListeningPublicationDocument = { _id: a.actor.userId, accountId: a.actor.userId, sessionId: a.actor.sessionId,
        clientId: a.clientId, publicationId: randomUUID(), preferenceRevision: 1, publisherRevision: 1, sequence: 1, playbackSequence: 1, blockedOccurrenceId: null,
        playback: value, sourceFingerprint: 'private-hash', observedAtMs: now, acceptedAtMs: now, visible: true, expiresAt: new Date(now + 25_000) };
    const values = Array.from({ length: 105 }, () => { const id = new ObjectId().toHexString(); return { ...template, _id: id, accountId: id }; });
    await publications().insertMany(values);
    await states().insertMany(values.map(value => ({ _id: value._id, accountId: value.accountId, enabled: true, revision: 1, publisherRevision: 1, updatedAt: new Date(now) })));
    await cleanupDeletedContentReferences('audioTrack', tracks[0]);
    assert.equal(await publications().countDocuments({ 'playback.mediaTrackId': tracks[0] }), 0);
    assert.equal(await states().countDocuments({ _id: { $in: values.map(value => value._id) }, publisherRevision: 2 }), 105);
    await cleanupListeningForContent(tracks[0]); assert.equal(await publications().countDocuments({}), 0);
});

test('concurrent account deletion and an in-flight report cannot leave a publication or resurrect its owner state', async () => {
    const { a, b } = await pair(); const { publisher, value } = await begin(a); now += LISTENING_LIMITS.renewMs;
    const outcomes = await Promise.allSettled([api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 11_000 })), deleteListenerAccountData(a.actor.userId)]);
    assert.equal(outcomes[1].status, 'fulfilled');
    if (outcomes[0].status === 'rejected') assert.ok(isError('social_session_required')(outcomes[0].reason) || isError('account_unavailable')(outcomes[0].reason));
    assert.equal(await publications().countDocuments({ _id: a.actor.userId }), 0); assert.equal(await states().countDocuments({ _id: a.actor.userId }), 0);
    assert.deepEqual(await status(b, a), []);
});

test('shared-room status requires the exact current ready playing controller and a live authority on both reports and reads', async () => {
    const { a, b } = await pair();
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(tracks[0]) }, { $set: { mediaRepresentation: {
        revision: `mr_${'a'.repeat(32)}`, objectKey: tracks[0], byteLength: 100, durationMs: 120_000, seekable: true,
        format: 'wav-pcm', etag: '"synthetic"', versionId: null } } });
    await roomAuthority.acquire();
    const rooms = createRoomService({ now: () => now, enabled: () => true, secret: () => secret });
    const actor = { ...a.actor, clientId: a.clientId };
    await rooms.mutate(actor, { ...identity(a.scope), action: 'create', mediaTrackIds: [tracks[0]] });
    let current = (await rooms.currentRoom(actor))!;
    const member = { roomId: current.roomId, memberId: current.self.memberId, controllerGeneration: current.self.controllerGeneration };
    await rooms.heartbeat(actor, { ...member, locallyPaused: false });
    const control = { ...member, expectedEpoch: current.epoch, expectedControlGeneration: current.controlGeneration,
        expectedPlaybackGeneration: current.timeline!.playbackGeneration, expectedEntryId: current.timeline!.entryId, expectedQueueRevision: current.queueRevision };
    await rooms.mutate(actor, { ...identity(a.scope), ...control, action: 'play' } as RoomCommand);
    current = (await rooms.currentRoom(actor))!;
    await preference(a); const publisher = await claim(a);
    const value = playback(); value.room = { roomId: current.roomId, memberId: current.self.memberId, epoch: current.epoch,
        controllerGeneration: current.self.controllerGeneration, playbackGeneration: current.timeline!.playbackGeneration,
        entryId: current.timeline!.entryId, mediaRevision: current.timeline!.mediaRevision };
    assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, false, 'Preparation is not actual playback.');
    await rooms.ready(actor, { ...member, expectedEpoch: current.epoch, preparationId: current.preparation!.preparationId,
        playbackGeneration: current.timeline!.playbackGeneration, entryId: current.timeline!.entryId,
        mediaRevision: current.timeline!.mediaRevision, sequence: 1, ready: true });
    now += 350;
    assert.equal((await api.reportListening(a.actor, playing(publisher, value))).accepted, true); assert.equal((await status(b, a)).length, 1);
    await rooms.heartbeat(actor, { ...member, locallyPaused: true }); assert.deepEqual(await status(b, a), []);
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 1_000 }))).accepted, false);
    await rooms.heartbeat(actor, { ...member, locallyPaused: false });
    assert.deepEqual(await status(b, a), [], 'Returning without current readiness cannot restore public status.');
    await rooms.ready(actor, { ...member, expectedEpoch: current.epoch, preparationId: 'current',
        playbackGeneration: current.timeline!.playbackGeneration, entryId: current.timeline!.entryId,
        mediaRevision: current.timeline!.mediaRevision, sequence: 2, ready: true });
    assert.deepEqual(await status(b, a), [], 'New readiness must not re-expose the missing-stop previous actual run.');
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...value, positionMs: 1500 }))).accepted, false);
    const resumed = { ...value, occurrenceId: randomUUID(), positionMs: 1500 };
    assert.equal((await api.reportListening(a.actor, playing(publisher, resumed))).accepted, true);
    assert.equal((await status(b, a)).length, 1);
    await rooms.disconnected(actor); assert.deepEqual(await status(b, a), []);
    await rooms.heartbeat(actor, { ...member, locallyPaused: false });
    await rooms.ready(actor, { ...member, expectedEpoch: current.epoch, preparationId: 'current',
        playbackGeneration: current.timeline!.playbackGeneration, entryId: current.timeline!.entryId,
        mediaRevision: current.timeline!.mediaRevision, sequence: 3, ready: true });
    assert.equal((await api.reportListening(a.actor, playing(publisher, { ...resumed, positionMs: 1600 }))).accepted, false);
    const reattached = { ...resumed, occurrenceId: randomUUID(), positionMs: 1700 };
    assert.equal((await api.reportListening(a.actor, playing(publisher, reattached))).accepted, true);
    await db().collection('socialAuthority').updateOne({ _id: 'rooms-v1' }, { $set: { expiresAt: new Date(0) } });
    assert.deepEqual(await status(b, a), []);
    await db().collection('socialAuthority').updateOne({ _id: 'rooms-v1' }, { $set: { expiresAt: new Date(Date.now() + 10_000) } });
    assert.equal((await status(b, a)).length, 1);
    const replacement = { ...actor, clientId: randomUUID() };
    assert.equal((await rooms.mutate(replacement, { ...identity(a.scope), action: 'takeControl', roomId: current.roomId, memberId: current.self.memberId })).outcome, 'applied');
    const suspended = await publications().findOne({ _id: a.actor.userId });
    assert.equal(suspended?.visible, false); assert.equal(suspended?.blockedOccurrenceId, reattached.occurrenceId);
    await roomAuthority.release(); assert.deepEqual(await status(b, a), []);
    const independent = await claim(a); assert.equal((await api.reportListening(a.actor, playing(independent, playback()))).accepted, true);
    await rooms.mutate(replacement, { ...identity(a.scope), action: 'end', roomId: current.roomId, memberId: current.self.memberId });
    assert.equal((await status(b, a)).length, 1, 'Room cleanup cannot clear an ordinary publisher on another controller.');
});
