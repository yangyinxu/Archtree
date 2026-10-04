import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { MongoServerError, ObjectId, type ClientSession } from 'mongodb';
import { createSocialService, type SocialServiceOptions } from '../src/application/social/socialService';
import { cleanupMusicSharesForContent, deleteMusicShares } from '../src/application/social/socialShareLifecycle';
import { MUSIC_SHARE_LIMITS, type SharedMusicType } from '../src/contracts/socialMusicV1';
import { SocialError, type SocialActor, type SocialApi, type SocialCommand, type SocialScope } from '../src/contracts/socialV1';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import type { MusicShareDocument } from '../src/repositories/social/musicShareDocuments';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
let now = Date.now();
let enabled = true;
let api: SocialApi;
let trackIds: string[];
let albumIds: string[];
const secret = 'synthetic-direct-music-share-secret';
const db = () => getDb()!;
const shares = () => db().collection<MusicShareDocument>('socialMusicShares');
const service = (options: SocialServiceOptions = {}) => createSocialService({ now: () => now, enabled: () => enabled, secret: () => secret, ...options });
before(async () => { harness = await startMongoReplicaSet('archtree-music-share-test'); });
beforeEach(async () => {
    now = Date.now(); enabled = true;
    for (const name of ['users', 'authSessions', 'socialProfiles', 'socialRelationships', 'socialMusicShares', 'socialMutations', 'socialBudgets',
        'socialOutbox', 'socialHandles', 'audioTracks', 'albums', 'socialRooms', 'socialInvitations', 'socialRoomParticipation']) await db().collection(name).deleteMany({});
    trackIds = Array.from({ length: 4 }, () => new ObjectId().toHexString()); albumIds = [new ObjectId().toHexString(), new ObjectId().toHexString()];
    await db().collection('audioTracks').insertMany(trackIds.map((id, index) => ({ _id: new ObjectId(id), title: `Public track ${index}`,
        uploadStatus: 'ready', publicationStatus: 'ready', s3Key: id, mediaType: 'audio', duration: '2:00', coverArtUrl: '/public-art.jpg' })));
    await db().collection('albums').insertMany(albumIds.map((id, index) => ({ _id: new ObjectId(id), title: `Public album ${index}`,
        lifecycleStatus: 'ready', audioTrackIds: trackIds.slice(0, 2), coverArtUrl: '/public-album.jpg' })));
    api = service();
});
after(async () => { await harness?.stop(); });
const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const person = async (name: string) => {
    const id = new ObjectId(); await db().collection('users').insertOne({ _id: id, email: `${name}@private.invalid`, username: `Private ${name}`, role: 'user' });
    const actor: SocialActor = { userId: id.toHexString(), sessionId: await AuthSession.create(id.toHexString(), randomUUID(), new Date(now + 90 * 86_400_000)) };
    const scope = await api.issueScope(actor);
    assert.equal((await api.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0, handle: name, alias: `Public ${name}`, discoverable: true })).outcome, 'applied');
    return { actor, scope, profile: (await api.ownProfile(actor))! };
};
type Person = Awaited<ReturnType<typeof person>>;
const friends = async (a: Person, b: Person) => {
    const current = await api.relationship(a.actor, b.profile.socialId);
    await api.mutate(a.actor, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId, expectedRevision: current?.revision ?? 0 });
    const pending = (await api.relationship(b.actor, a.profile.socialId))!;
    await api.mutate(b.actor, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId, expectedRevision: pending.revision });
};
const pair = async () => { const a = await person('alice'); const b = await person('bobby'); await friends(a, b); return { a, b }; };
const sendIntent = async (a: Person, b: Person, contentId = trackIds[0], contentType: SharedMusicType = 'audioTrack'): Promise<SocialCommand> => ({
    ...identity(a.scope), action: 'shareMusic', targetSocialId: b.profile.socialId,
    expectedRevision: (await api.relationship(a.actor, b.profile.socialId))!.revision, contentType, contentId
});
const send = async (a: Person, b: Person, id = trackIds[0], type: SharedMusicType = 'audioTrack', target = api) => target.mutate(a.actor, await sendIntent(a, b, id, type));
const list = (who: Person, direction: 'incoming' | 'outgoing' = 'incoming', limit = 20, cursor?: string) => api.musicShares(who.actor, direction, limit, cursor);
const outbox = async (who: Person) => (await db().collection('socialOutbox').findOne({ _id: who.actor.userId }))?.revision ?? 0;
const errorCode = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;
const transaction = async (work: (session: ClientSession) => Promise<unknown>) => {
    const session = getDatabaseClient().startSession(); try { await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
};

test('direct track and album shares use private current cards, status-only receipts and duplicate suppression', async () => {
    const { a, b } = await pair(); const outsider = await person('outsider');
    const before = [await outbox(a), await outbox(b)]; const intent = await sendIntent(a, b);
    assert.equal((await api.mutate(a.actor, intent)).outcome, 'applied');
    assert.equal((await api.mutate(a.actor, intent)).replayed, true); assert.equal((await send(a, b)).outcome, 'noop');
    assert.deepEqual([await outbox(a), await outbox(b)], before.map(value => value + 1));
    const incoming = (await list(b)).items[0]; const outgoing = (await list(a, 'outgoing')).items[0];
    assert.equal(incoming.shareId, outgoing.shareId); assert.equal(incoming.peer.socialId, a.profile.socialId); assert.equal(outgoing.peer.socialId, b.profile.socialId);
    assert.equal(incoming.content?.title, 'Public track 0'); assert.equal(incoming.content?.contentType, 'audioTrack');
    assert.deepEqual(Object.keys(incoming).sort(), ['content', 'contentId', 'contentType', 'createdAtMs', 'expiresAtMs', 'peer', 'shareId']);
    assert.deepEqual(Object.keys(incoming.content!).sort(), ['artistNames', 'artworkUrl', 'contentType', 'id', 'title']);
    for (const value of [a.actor.userId, b.actor.userId, a.actor.sessionId, b.actor.sessionId, '@private.invalid', 's3Key', 'streamUrl']) assert.equal(JSON.stringify(incoming).includes(value), false);
    assert.deepEqual((await list(outsider)).items, []); assert.deepEqual((await list(a)).items, []);
    assert.equal((await send(a, b, albumIds[0], 'album')).outcome, 'applied');
    assert.equal((await list(b)).items.find(value => value.contentType === 'album')?.content?.title, 'Public album 0');
    const receipt = await db().collection('socialMutations').findOne({ commandId: intent.commandId });
    assert.deepEqual(receipt?.result, { commandId: intent.commandId, outcome: 'applied' });
});

test('friendship revision and ready-content admission reject stale, unauthorized and unavailable sends without domain writes', async () => {
    const { a, b } = await pair(); const outsider = await person('outsider');
    const intent = await sendIntent(a, b); assert.ok('expectedRevision' in intent);
    const before = [await outbox(a), await outbox(b)];
    assert.equal((await api.mutate(a.actor, { ...intent, expectedRevision: intent.expectedRevision + 1 })).code, 'relationship_changed');
    assert.equal((await api.mutate(outsider.actor, { ...intent, ...identity(outsider.scope) })).code, 'profile_unavailable');
    for (const [contentType, contentId] of [['audioTrack', trackIds[0]], ['album', albumIds[0]]] as const) {
        await db().collection(contentType === 'album' ? 'albums' : 'audioTracks').updateOne({ _id: new ObjectId(contentId) },
            { $set: contentType === 'album' ? { lifecycleStatus: 'deleting' } : { uploadStatus: 'deleting' } });
        assert.equal((await send(a, b, contentId, contentType)).code, 'music_unavailable');
    }
    assert.equal(await shares().countDocuments({}), 0); assert.deepEqual([await outbox(a), await outbox(b)], before);
});

test('replacement uses current public metadata while unavailable sources expose no former title or artwork', async () => {
    const { a, b } = await pair(); await send(a, b); const first = (await list(b)).items[0];
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(trackIds[0]) }, { $set: { title: 'Replacement title', mediaType: 'audio' } });
    assert.equal((await list(b)).items[0].content?.title, 'Replacement title'); assert.equal((await list(b)).items[0].shareId, first.shareId);
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(trackIds[0]) }, { $set: { uploadStatus: 'deleteFailed' } });
    const unavailable = (await list(b)).items[0]; assert.equal(unavailable.content, null);
    assert.equal(JSON.stringify(unavailable).includes('Replacement title'), false); assert.equal(JSON.stringify(unavailable).includes('/public-art.jpg'), false);
    assert.equal((await api.mutate(b.actor, { ...identity(b.scope), action: 'dismissMusicShare', shareId: first.shareId })).outcome, 'applied');
});

test('dismiss and withdraw are owner-bound safety actions and stale incarnations never remove a new share', async () => {
    const { a, b } = await pair(); const outsider = await person('outsider'); await send(a, b); const original = (await list(b)).items[0];
    for (const [who, action] of [[a, 'dismissMusicShare'], [b, 'withdrawMusicShare'], [outsider, 'dismissMusicShare']] as const)
        assert.equal((await api.mutate(who.actor, { ...identity(who.scope), action, shareId: original.shareId })).outcome, 'noop');
    assert.equal(await shares().countDocuments({}), 1); enabled = false;
    await assert.rejects(send(a, b, trackIds[1]), errorCode('social_disabled'));
    const dismiss = { ...identity(b.scope), action: 'dismissMusicShare' as const, shareId: original.shareId };
    assert.equal((await api.mutate(b.actor, dismiss)).outcome, 'applied'); enabled = true;
    await send(a, b); const replacement = (await list(b)).items[0]; assert.notEqual(replacement.shareId, original.shareId);
    assert.equal((await api.mutate(b.actor, dismiss)).replayed, true);
    assert.equal((await api.mutate(a.actor, { ...identity(a.scope), action: 'withdrawMusicShare', shareId: original.shareId })).outcome, 'noop');
    assert.equal((await list(b)).items[0].shareId, replacement.shareId); enabled = false;
    assert.equal((await api.mutate(a.actor, { ...identity(a.scope), action: 'withdrawMusicShare', shareId: replacement.shareId })).outcome, 'applied');
});

test('pagination uses stable tie-breaking, filters stale pairs before filling and rejects foreign cursors', async () => {
    const { a, b } = await pair(); const third = await person('third'); await friends(third, b);
    for (const id of trackIds) await send(a, b, id);
    await send(third, b, albumIds[0], 'album');
    await db().collection('socialRelationships').updateOne({ _id: [third.actor.userId, b.actor.userId].sort().join(':') }, { $set: { state: 'none' } });
    const first = await list(b, 'incoming', 2); assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
    const second = await list(b, 'incoming', 2, first.nextCursor); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(value => value.shareId)).size, 4);
    for (const [who, direction, cursor] of [[a, 'incoming', first.nextCursor], [b, 'outgoing', first.nextCursor], [b, 'incoming', b.scope.scopeToken]] as const)
        await assert.rejects(list(who, direction, 2, cursor), errorCode('cursor_invalid'));
    now += 900_001; await assert.rejects(list(b, 'incoming', 2, first.nextCursor), errorCode('cursor_invalid'));
});

test('logical retention precedes TTL cleanup and a new send creates a fresh incarnation', async () => {
    const { a, b } = await pair(); await send(a, b); const original = (await list(b)).items[0];
    now += MUSIC_SHARE_LIMITS.retentionMs; assert.deepEqual((await list(b)).items, []); assert.equal(await shares().countDocuments({}), 1);
    a.scope = await api.issueScope(a.actor); await send(a, b); const replacement = (await list(b)).items[0];
    assert.notEqual(original.shareId, replacement.shareId); assert.equal(await shares().countDocuments({}), 1);
});

for (const action of ['remove', 'block', 'deactivate', 'delete'] as const) {
    test(`${action} atomically clears both directions without restoring previous shares on reactivation`, async () => {
        const { a, b } = await pair(); await send(a, b); await send(b, a, trackIds[1]); const before = await shares().find({}).toArray();
        if (action === 'delete') {
            await assert.rejects(deleteListenerAccountData(a.actor.userId, { afterSocialCleanup: async () => { throw new Error('synthetic rollback'); } }), /synthetic rollback/);
            assert.deepEqual(await shares().find({}).toArray(), before);
            assert.equal((await deleteListenerAccountData(a.actor.userId)).status, 'deleted');
            assert.equal(await db().collection('socialOutbox').findOne({ _id: a.actor.userId }), null);
        } else if (action === 'deactivate') await api.mutate(a.actor, { ...identity(a.scope), action });
        else if (action === 'block') await api.mutate(a.actor, { ...identity(a.scope), action, targetSocialId: b.profile.socialId });
        else {
            await api.mutate(a.actor, { ...identity(a.scope), action, targetSocialId: b.profile.socialId, expectedRevision: (await api.relationship(a.actor, b.profile.socialId))!.revision });
            await friends(a, b); assert.deepEqual((await list(b)).items, []);
        }
        assert.equal(await shares().countDocuments({}), 0); assert.deepEqual((await list(b)).items, []);
    });
}

test('profile updates refresh current peer cards and discovery opt-out preserves shares', async () => {
    const { a, b } = await pair(); await send(a, b); const revision = await outbox(b); const profile = (await api.ownProfile(a.actor))!;
    await api.mutate(a.actor, { ...identity(a.scope), action: 'profile', expectedRevision: profile.revision,
        handle: profile.handle, alias: 'Current alias', discoverable: false });
    assert.equal((await list(b)).items[0].peer.alias, 'Current alias'); assert.ok(await outbox(b) > revision);
});

for (const limit of ['incoming', 'outgoing', 'daily'] as const) {
    test(`${limit} admission quota rejects new shares without consuming new recipient notifications`, async () => {
        const { a, b } = await pair(); await send(a, b); const template = (await shares().findOne({}))!;
        if (limit === 'daily') await db().collection('socialBudgets').updateOne({ _id: b.actor.userId }, { $set: { musicIncomingDay: Math.floor(now / 86_400_000), musicIncoming: MUSIC_SHARE_LIMITS.incomingPerDay } });
        else await shares().insertMany(Array.from({ length: 99 }, () => ({ ...template, _id: `ms_${new ObjectId().toHexString()}${'0'.repeat(8)}`,
            ...(limit === 'outgoing' ? { recipientAccountId: new ObjectId().toHexString() } : { senderAccountId: new ObjectId().toHexString() }) })));
        const before = [await outbox(a), await outbox(b)];
        assert.equal((await send(a, b, trackIds[1])).code, limit === 'daily' ? 'music_share_limit' : 'music_share_capacity');
        assert.equal((await send(a, b)).outcome, 'noop'); assert.deepEqual([await outbox(a), await outbox(b)], before);
    });
}

test('simultaneous identical sends and uncertain commits preserve one share and its immutable result', async () => {
    const { a, b } = await pair(); const first = await sendIntent(a, b); const second = await sendIntent(a, b);
    const results = await Promise.all([api.mutate(a.actor, first), api.mutate(a.actor, second)]);
    assert.deepEqual(results.map(result => result.outcome).sort(), ['applied', 'noop']); assert.equal(await shares().countDocuments({}), 1);
    let attempts = 0; const uncertain = service({ beforeCommit: async session => {
        attempts += 1; await session.commitTransaction(); const error = new MongoServerError({ message: 'synthetic unknown share acknowledgement' });
        error.addErrorLabel('UnknownTransactionCommitResult'); error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    const intent = await sendIntent(a, b, trackIds[1]); await assert.rejects(uncertain.mutate(a.actor, intent), errorCode('mutation_outcome_unknown'));
    assert.equal(attempts, 1); assert.equal(await shares().countDocuments({}), 2);
    assert.deepEqual(await api.outcome(a.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }), { commandId: intent.commandId, outcome: 'applied', replayed: true });
    assert.equal((await api.mutate(a.actor, intent)).replayed, true); assert.equal(await shares().countDocuments({}), 2);
    await assert.rejects(api.mutate(a.actor, { ...intent, contentId: trackIds[2] } as SocialCommand), errorCode('idempotency_conflict'));
});

test('content deletion visibility and retryable reference cleanup remove only matching shares', async () => {
    const { a, b } = await pair(); await send(a, b); await send(a, b, albumIds[0], 'album');
    await db().collection('audioTracks').updateOne({ _id: new ObjectId(trackIds[0]) }, { $set: { uploadStatus: 'deleting' } });
    assert.equal((await list(b)).items.find(item => item.contentId === trackIds[0])?.content, null);
    const before = await shares().find({}).toArray();
    await assert.rejects(transaction(async session => { await deleteMusicShares({ contentType: 'audioTrack', contentId: trackIds[0] }, session, now); throw new Error('synthetic cleanup rollback'); }), /synthetic cleanup rollback/);
    assert.deepEqual(await shares().find({}).toArray(), before);
    await cleanupDeletedContentReferences('audioTrack', trackIds[0]);
    assert.equal(await shares().countDocuments({}), 1); assert.equal((await list(b)).items[0].contentType, 'album');
    await cleanupMusicSharesForContent('audioTrack', trackIds[0]); assert.equal(await shares().countDocuments({}), 1);
});

test('block winning send admission prevents a stale share', async () => {
    const { a, b } = await pair(); let blocked = false;
    const racing = service({ beforeAccountFence: async () => {
        if (blocked) return; blocked = true;
        await api.mutate(b.actor, { ...identity(b.scope), action: 'block', targetSocialId: a.profile.socialId });
    } });
    const intent = await sendIntent(a, b); assert.equal((await racing.mutate(a.actor, intent)).code, 'profile_unavailable');
    assert.equal(await shares().countDocuments({}), 0);
});

for (const contentType of ['album', 'audioTrack'] as const) {
    test(`${contentType} deletion winning admission rolls back its stale share transaction`, async () => {
        const { a, b } = await pair(); const contentId = contentType === 'album' ? albumIds[0] : trackIds[0];
        let deleted = false;
        const racing = service({ beforeAccountFence: async () => {
            if (deleted) return; deleted = true;
            await db().collection(contentType === 'album' ? 'albums' : 'audioTracks').updateOne({ _id: new ObjectId(contentId) },
                { $set: contentType === 'album' ? { lifecycleStatus: 'deleting' } : { uploadStatus: 'deleting' } });
        } });
        const before = await outbox(b);
        assert.equal((await send(a, b, contentId, contentType, racing)).code, 'music_unavailable');
        assert.equal(await shares().countDocuments({}), 0); assert.equal(await outbox(b), before);
    });
}

test('expired full incoming and outgoing lists stay physically bounded without any TTL worker', async () => {
    const { a, b } = await pair();
    for (let cycle = 0; cycle < 2; cycle += 1) {
        await shares().deleteMany({});
        await shares().insertMany(Array.from({ length: 200 }, (_, index): MusicShareDocument => ({
            _id: `ms_${new ObjectId().toHexString()}${'0'.repeat(8)}`, senderAccountId: index < 100 ? a.actor.userId : b.actor.userId,
            recipientAccountId: index < 100 ? b.actor.userId : a.actor.userId, accountIds: [a.actor.userId, b.actor.userId].sort(),
            contentType: 'audioTrack', contentId: new ObjectId().toHexString(), createdAt: new Date(now), expiresAt: new Date(now + MUSIC_SHARE_LIMITS.retentionMs)
        })));
        now += MUSIC_SHARE_LIMITS.retentionMs; a.scope = await api.issueScope(a.actor);
        assert.equal(await shares().countDocuments({}), 200, 'The test uses logical expiry while every physical row is still present.');
        assert.equal((await send(a, b)).outcome, 'applied'); assert.equal(await shares().countDocuments({}), 1);
    }
    await transaction(session => deleteMusicShares({ accountIds: a.actor.userId }, session, now));
    assert.equal(await shares().countDocuments({}), 0);
});

test('content cleanup processes multiple bounded batches and never recreates a deleted account outbox', async () => {
    const { a, b } = await pair(); await send(a, b); const template = (await shares().findOne({}))!;
    await shares().insertMany(Array.from({ length: 101 }, (): MusicShareDocument => ({ ...template,
        _id: `ms_${new ObjectId().toHexString()}${'0'.repeat(8)}` })));
    await db().collection('users').deleteOne({ _id: new ObjectId(a.actor.userId) }); await db().collection('socialOutbox').deleteOne({ _id: a.actor.userId });
    await cleanupMusicSharesForContent('audioTrack', trackIds[0]);
    assert.equal(await shares().countDocuments({}), 0); assert.equal(await db().collection('socialOutbox').findOne({ _id: a.actor.userId }), null);
});

test('public projection drops unknown fields and unsafe artwork while keeping Unicode within card bounds', async () => {
    const { a, b } = await pair(); await send(a, b);
    const projected = service({ resolveMusicShareContent: async (contentType, id) => ({ id, contentType,
        title: '🎵'.repeat(300), artistNames: Array.from({ length: 30 }, () => '🎵'.repeat(200)),
        artworkUrl: 'https://private-user:secret@example.test/art.jpg', rawOwner: 'private-owner' } as never) });
    const item = (await projected.musicShares(b.actor, 'incoming', 20)).items[0];
    assert.equal(item.content?.artworkUrl, ''); assert.equal([...item.content!.title].length, 200);
    assert.equal(item.content?.artistNames.length, 20); assert.equal([...item.content!.artistNames[0]].length, 160);
    assert.equal(JSON.stringify(item).includes('private-owner'), false);
});

test('revoked sessions and simultaneous account deletion cannot leave shares or resurrect outboxes', async () => {
    const { a, b } = await pair(); await send(a, b); await send(b, a, trackIds[1]);
    const results = await Promise.all([deleteListenerAccountData(a.actor.userId), deleteListenerAccountData(b.actor.userId)]);
    assert.ok(results.every(result => result.status === 'deleted')); assert.equal(await shares().countDocuments({}), 0);
    assert.equal(await db().collection('socialOutbox').countDocuments({}), 0);
    await assert.rejects(api.musicShares(a.actor, 'incoming', 20), errorCode('social_session_required'));
});

test('recipient deletion winning send admission leaves no orphan share, recipient budget or outbox', async () => {
    const { a, b } = await pair(); const intent = await sendIntent(a, b); let deleted = false;
    const racing = service({ beforeAccountFence: async () => {
        if (deleted) return; deleted = true;
        assert.equal((await deleteListenerAccountData(b.actor.userId)).status, 'deleted');
    } });
    assert.equal((await racing.mutate(a.actor, intent)).code, 'profile_unavailable');
    assert.equal(await shares().countDocuments({}), 0);
    assert.equal(await db().collection('socialOutbox').findOne({ _id: b.actor.userId }), null);
    assert.equal(await db().collection('socialBudgets').findOne({ _id: b.actor.userId }), null);
});
