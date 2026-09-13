import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { createSocialService } from '../src/application/social/socialService';
import { SOCIAL_LIMITS } from '../src/contracts/socialV1';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import { databaseIndexes, verifyRequiredDatabaseIndexes } from '../src/infrastructure/databaseIndexes';
import type {
    SocialHandleDocument, SocialOutboxDocument, SocialProfileDocument,
    SocialReceiptDocument, SocialRelationshipDocument
} from '../src/repositories/social/socialDocuments';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { AccountReferenceUnavailableError, touchActiveAccount } from '../src/services/accountReferenceFenceService';
import { deleteSocialAccountData } from '../src/services/socialAccountLifecycleService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

const socialCollections = [
    'socialProfiles', 'socialRelationships', 'socialMutations', 'socialOutbox', 'socialBudgets', 'socialHandles'
] as const;
let harness: MongoReplicaSetHarness | undefined;
before(async () => { harness = await startMongoReplicaSet('archtree-social-account-lifecycle-test'); });
after(async () => { await harness?.stop(); });

/** Creates valid synthetic account/profile records without accessing a developer account. */
const seedAccount = async () => {
    const _id = new ObjectId();
    const accountId = _id.toHexString();
    const socialId = `s_${accountId}00000000`;
    const handle = `u_${accountId.slice(-20)}`;
    const now = new Date();
    await getDb()!.collection('users').insertOne({ _id, email: `${accountId}@example.test`, role: 'user' });
    await getDb()!.collection<SocialProfileDocument>('socialProfiles').insertOne({
        _id: socialId, accountId, handle, alias: 'Synthetic listener', active: true,
        discoverable: true, revision: 1, updatedAt: now
    });
    await getDb()!.collection<SocialHandleDocument>('socialHandles').insertOne({ _id: handle, accountId });
    await getDb()!.collection('socialBudgets').insertOne({ _id: accountId, accountId, commands: 1 });
    await getDb()!.collection<SocialOutboxDocument>('socialOutbox').insertOne({
        _id: accountId, accountId, revision: 3, updatedAt: now
    });
    await getDb()!.collection<SocialReceiptDocument>('socialMutations').insertOne({
        _id: `${accountId}:scope:command`, accountId, scopeId: 'synthetic-scope',
        commandId: 'synthetic-command', digest: 'synthetic-digest',
        result: { commandId: 'synthetic-command', outcome: 'applied' },
        scopeExpiresAt: new Date(now.getTime() + SOCIAL_LIMITS.scopeMs),
        expiresAt: new Date(now.getTime() + SOCIAL_LIMITS.scopeMs + SOCIAL_LIMITS.receiptGraceMs)
    });
    return { _id, accountId, socialId, handle };
};
type SeededAccount = Awaited<ReturnType<typeof seedAccount>>;

/** Persists the same canonical pair shape used by the social transaction service. */
const seedRelationship = async (
    left: SeededAccount, right: SeededAccount,
    state: SocialRelationshipDocument['state'] = 'accepted', blockedBy: string[] = []
) => {
    const parties = [left, right].sort((a, b) => a.accountId.localeCompare(b.accountId));
    const accountIds = parties.map(party => party.accountId);
    const row: SocialRelationshipDocument = {
        _id: accountIds.join(':'), accountIds, socialIds: parties.map(party => party.socialId),
        state, blockedBy, revision: 1, updatedAt: new Date(),
        ...(state === 'pending' ? { requestedBy: left.accountId } : {})
    };
    await getDb()!.collection<SocialRelationshipDocument>('socialRelationships').insertOne(row);
    return row;
};

/** Captures persisted state so a blocked/aborted deletion must leave every document unchanged. */
const snapshot = async () => {
    const result: Record<string, unknown[]> = {};
    for (const name of ['users', 'authSessions', 'playlists', ...socialCollections]) {
        result[name] = await getDb()!.collection(name).find().sort({ _id: 1 }).toArray();
    }
    return result;
};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
};

test('startup provisions all social collections and validates required cleanup and uniqueness indexes', async () => {
    const names = new Set((await getDb()!.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
    for (const name of socialCollections) assert.ok(names.has(name), name);
    await verifyRequiredDatabaseIndexes(getDb()!);
    for (const definition of databaseIndexes.filter(index => index.collection.startsWith('social'))) {
        const actual = await getDb()!.collection(definition.collection).indexes();
        assert.ok(actual.some(index => JSON.stringify(index.key) === JSON.stringify(definition.keys)), definition.collection);
    }
});

test('account deletion removes both relationship directions and reserves a handle without retaining its former owner', async () => {
    const owner = await seedAccount();
    const peer = await seedAccount();
    const blocked = await seedAccount();
    const unrelated = await seedAccount();
    await seedRelationship(owner, peer);
    await seedRelationship(blocked, owner, 'none', [blocked.accountId, owner.accountId]);
    const untouchedRelationship = await seedRelationship(peer, unrelated, 'none', [peer.accountId]);
    const peerProfile = await getDb()!.collection('socialProfiles').findOne({ accountId: peer.accountId });
    const peerReceipt = await getDb()!.collection('socialMutations').findOne({ accountId: peer.accountId });
    const untouchedOutbox = await getDb()!.collection('socialOutbox').findOne({ accountId: unrelated.accountId });
    const before = Date.now();

    assert.deepEqual(await deleteListenerAccountData(owner.accountId), { status: 'deleted' });

    assert.equal(await getDb()!.collection('users').findOne({ _id: owner._id }), null);
    for (const name of ['socialProfiles', 'socialMutations', 'socialOutbox', 'socialBudgets']) {
        assert.equal(await getDb()!.collection(name).countDocuments({ accountId: owner.accountId }), 0, name);
    }
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: owner.accountId }), 0);
    const handle = await getDb()!.collection<SocialHandleDocument>('socialHandles').findOne({ _id: owner.handle });
    assert.ok(handle?.expiresAt);
    assert.deepEqual(Object.keys(handle).sort(), ['_id', 'expiresAt']);
    assert.ok(handle.expiresAt.getTime() >= before + SOCIAL_LIMITS.handleReservationMs);
    assert.ok(handle.expiresAt.getTime() <= Date.now() + SOCIAL_LIMITS.handleReservationMs);
    assert.deepEqual(await getDb()!.collection('socialProfiles').findOne({ accountId: peer.accountId }), peerProfile);
    assert.deepEqual(await getDb()!.collection('socialMutations').findOne({ accountId: peer.accountId }), peerReceipt);
    assert.deepEqual(await getDb()!.collection<SocialRelationshipDocument>('socialRelationships')
        .findOne({ _id: untouchedRelationship._id }), untouchedRelationship);
    assert.deepEqual(await getDb()!.collection('socialOutbox').findOne({ accountId: unrelated.accountId }), untouchedOutbox);
    for (const participant of [peer, blocked]) {
        const outbox = await getDb()!.collection<SocialOutboxDocument>('socialOutbox').findOne({ _id: participant.accountId });
        assert.equal(outbox?.revision, 4);
        assert.deepEqual(Object.keys(outbox!).sort(), ['_id', 'accountId', 'revision', 'updatedAt']);
    }
    // Repeating account deletion cannot extend the anonymous reservation or emit again.
    assert.deepEqual(await deleteListenerAccountData(owner.accountId), { status: 'missing' });
    assert.deepEqual(await getDb()!.collection<SocialHandleDocument>('socialHandles').findOne({ _id: owner.handle }), handle);
    assert.equal((await getDb()!.collection('socialOutbox').findOne({ accountId: peer.accountId }))?.revision, 4);
});

test('social cleanup is unavailable outside the account transaction', async () => {
    const session = getDatabaseClient().startSession();
    try {
        await assert.rejects(deleteSocialAccountData(new ObjectId().toHexString(), session), /requires its account-deletion transaction/);
    } finally { await session.endSession(); }
});

test('every existing avatar and shared provenance blocker preserves the complete social state', async () => {
    const shared = ['artists', 'albums', 'audioTracks', 'carousels', 'contentCollections', 'pages', 'imageAssets'];
    for (const blocker of ['attached', 'pending-avatar', 'retained-avatar', ...shared]) {
        const owner = await seedAccount();
        const peer = await seedAccount();
        await seedRelationship(owner, peer, 'pending');
        let expected: 'avatarAttached' | 'avatarCleanupPending' | 'sharedProvenance';
        if (blocker === 'attached') {
            await getDb()!.collection('users').updateOne({ _id: owner._id }, { $set: { avatarAssetId: new ObjectId().toHexString() } });
            expected = 'avatarAttached';
        } else if (blocker === 'pending-avatar') {
            await getDb()!.collection('avatarMutations').insertOne({ userId: owner.accountId, status: 'pending' });
            expected = 'avatarCleanupPending';
        } else if (blocker === 'retained-avatar') {
            await getDb()!.collection('imageAssets').insertOne({ ownerType: 'user', ownerId: owner.accountId });
            expected = 'avatarCleanupPending';
        } else {
            await getDb()!.collection(blocker).insertOne({
                createdBy: owner.accountId,
                ...(blocker === 'imageAssets' ? { ownerType: 'artist' } : {}),
                ...(blocker === 'pages' ? { slug: `social-blocker-${owner.accountId}` } : {})
            });
            expected = 'sharedProvenance';
        }
        const original = await snapshot();
        assert.deepEqual(await deleteListenerAccountData(owner.accountId), { status: expected }, blocker);
        assert.deepEqual(await snapshot(), original, blocker);
    }
});

test('a failure after social cleanup rolls back the graph, handles, invalidations and account deletion', async () => {
    const owner = await seedAccount();
    const peer = await seedAccount();
    await seedRelationship(owner, peer);
    await getDb()!.collection('authSessions').insertOne({
        userId: owner.accountId, refreshTokenHash: `rollback-${owner.accountId}`, expiresAt: new Date(Date.now() + 60_000)
    });
    await getDb()!.collection('playlists').insertOne({ ownerUserId: owner.accountId, name: 'Keep on rollback' });
    const original = await snapshot();
    await assert.rejects(deleteListenerAccountData(owner.accountId, {
        afterSocialCleanup: async () => { throw new Error('synthetic cleanup failure'); }
    }), /synthetic cleanup failure/);
    assert.deepEqual(await snapshot(), original);
    assert.deepEqual(await deleteListenerAccountData(owner.accountId), { status: 'deleted' });
    assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId: owner.accountId }), 0);
    assert.equal(await getDb()!.collection('playlists').countDocuments({ ownerUserId: owner.accountId }), 0);
});

/** A synthetic writer takes the production user fences before inserting both-party state. */
const writeFencedRequest = async (actor: SeededAccount, recipient: SeededAccount, afterWrite?: () => Promise<void>) => {
    const session = getDatabaseClient().startSession();
    const accountIds = [actor.accountId, recipient.accountId].sort();
    try {
        await session.withTransaction(async () => {
            for (const accountId of accountIds) await touchActiveAccount(accountId, session);
            await getDb()!.collection<SocialRelationshipDocument>('socialRelationships').insertOne({
                _id: accountIds.join(':'), accountIds,
                socialIds: accountIds.map(id => id === actor.accountId ? actor.socialId : recipient.socialId),
                state: 'pending', requestedBy: actor.accountId, blockedBy: [], revision: 1, updatedAt: new Date()
            }, { session });
            await afterWrite?.();
        });
    } finally { await session.endSession(); }
};

test('a request committed before target deletion is removed and not orphaned', async () => {
    const actor = await seedAccount();
    const target = await seedAccount();
    const written = deferred();
    const release = deferred();
    const deletionStarted = deferred();
    const mutation = writeFencedRequest(actor, target, async () => { written.resolve(); await release.promise; });
    await written.promise;
    const deletion = deleteListenerAccountData(target.accountId, {
        beforeAccountFence: async () => { deletionStarted.resolve(); }
    });
    await deletionStarted.promise;
    release.resolve();
    await mutation;
    assert.deepEqual(await deletion, { status: 'deleted' });
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: target.accountId }), 0);
    assert.equal((await getDb()!.collection('socialOutbox').findOne({ accountId: actor.accountId }))?.revision, 4);
});

test('target deletion owning the account fence rejects a request writer without recreating social references', async () => {
    const actor = await seedAccount();
    const target = await seedAccount();
    const fenced = deferred();
    const release = deferred();
    const deletion = deleteListenerAccountData(target.accountId, {
        afterAccountFence: async () => { fenced.resolve(); await release.promise; }
    });
    await fenced.promise;
    const mutation = writeFencedRequest(actor, target).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    assert.deepEqual(await deletion, { status: 'deleted' });
    assert.ok((await mutation).error instanceof AccountReferenceUnavailableError);
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: target.accountId }), 0);
    assert.equal(await getDb()!.collection('socialOutbox').countDocuments({ accountId: target.accountId }), 0);
});

test('simultaneous deletion of both friends cannot recreate a peer outbox after its account is gone', async () => {
    const left = await seedAccount();
    const right = await seedAccount();
    await seedRelationship(left, right);
    const outcomes = await Promise.all([deleteListenerAccountData(left.accountId), deleteListenerAccountData(right.accountId)]);
    assert.deepEqual(outcomes, [{ status: 'deleted' }, { status: 'deleted' }]);
    for (const account of [left, right]) {
        assert.equal(await getDb()!.collection('users').countDocuments({ _id: account._id }), 0);
        assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: account.accountId }), 0);
        assert.equal(await getDb()!.collection('socialOutbox').countDocuments({ accountId: account.accountId }), 0);
    }
});

/** Installs only a synthetic revocable session for exercising the real social service. */
const sessionActor = async (account: SeededAccount) => {
    const sessionId = new ObjectId();
    await getDb()!.collection('authSessions').insertOne({
        _id: sessionId, userId: account.accountId, refreshTokenHash: `social-lifecycle-${sessionId.toHexString()}`,
        expiresAt: new Date(Date.now() + SOCIAL_LIMITS.scopeMs)
    });
    return { userId: account.accountId, sessionId: sessionId.toHexString() };
};

test('real social request, receipt and invalidations commit before target deletion cleans only the target identity', async () => {
    const actorAccount = await seedAccount();
    const target = await seedAccount();
    const actor = await sessionActor(actorAccount);
    const written = deferred();
    const release = deferred();
    const deletionStarted = deferred();
    const service = createSocialService({
        enabled: () => true, secret: () => 'synthetic-social-lifecycle-secret',
        beforeCommit: async () => { written.resolve(); await release.promise; }
    });
    const scope = await service.issueScope(actor);
    const command = { action: 'request' as const, scopeToken: scope.scopeToken, commandId: 'real-request-before-delete',
        targetSocialId: target.socialId, expectedRevision: 0 };
    const mutation = service.mutate(actor, command);
    await written.promise;
    const deletion = deleteListenerAccountData(target.accountId, {
        beforeAccountFence: async () => { deletionStarted.resolve(); }
    });
    await deletionStarted.promise;
    release.resolve();
    assert.equal((await mutation).outcome, 'applied');
    assert.deepEqual(await deletion, { status: 'deleted' });
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: target.accountId }), 0);
    assert.equal(await getDb()!.collection('socialOutbox').countDocuments({ accountId: target.accountId }), 0);
    const replay = await service.mutate(actor, command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, 'applied');
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: target.accountId }), 0);
    const receipt = await getDb()!.collection('socialMutations').findOne({ accountId: actorAccount.accountId, commandId: command.commandId });
    assert.ok(receipt);
    assert.equal(JSON.stringify(receipt).includes(target.accountId), false);
    assert.equal(JSON.stringify(receipt).includes(target.socialId), false);
    assert.equal(JSON.stringify(receipt).includes(target.handle), false);
});

test('a real social request admitted before recipient deletion cannot restore its vanished profile', async () => {
    const actorAccount = await seedAccount();
    const target = await seedAccount();
    const actor = await sessionActor(actorAccount);
    const admitted = deferred();
    const release = deferred();
    const service = createSocialService({
        enabled: () => true, secret: () => 'synthetic-social-lifecycle-secret',
        beforeAccountFence: async () => { admitted.resolve(); await release.promise; }
    });
    const scope = await service.issueScope(actor);
    const mutation = service.mutate(actor, {
        action: 'request', scopeToken: scope.scopeToken, commandId: 'real-request-after-delete',
        targetSocialId: target.socialId, expectedRevision: 0
    });
    await admitted.promise;
    assert.deepEqual(await deleteListenerAccountData(target.accountId), { status: 'deleted' });
    release.resolve();
    const outcome = await mutation;
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'profile_unavailable');
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({ accountIds: target.accountId }), 0);
    assert.equal(await getDb()!.collection('socialProfiles').countDocuments({ accountId: target.accountId }), 0);
    assert.equal(await getDb()!.collection('socialOutbox').countDocuments({ accountId: target.accountId }), 0);
});

test('unexpected graph capacity overflow refuses deletion before any identity is removed', async () => {
    const owner = await seedAccount();
    const now = new Date();
    const rows: SocialRelationshipDocument[] = Array.from({ length: SOCIAL_LIMITS.edges + 1 }, () => {
        const peer = new ObjectId().toHexString();
        const accountIds = [owner.accountId, peer].sort();
        return { _id: accountIds.join(':'), accountIds,
            socialIds: accountIds.map(id => `s_${id}00000000`),
            state: 'none', blockedBy: [owner.accountId], revision: 1, updatedAt: now };
    });
    await getDb()!.collection<SocialRelationshipDocument>('socialRelationships').insertMany(rows);
    const original = await snapshot();
    await assert.rejects(deleteListenerAccountData(owner.accountId), /bounded relationship limit/);
    assert.deepEqual(await snapshot(), original);
});
