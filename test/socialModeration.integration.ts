import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { createSocialModerationService, SOCIAL_MODERATION_LIMITS, type SocialModerationApi } from '../src/application/social/socialModerationService';
import { createSocialService, type SocialServiceOptions } from '../src/application/social/socialService';
import {
    SOCIAL_LIMITS, SocialError, type SocialActor, type SocialApi, type SocialCommand, type SocialScope
} from '../src/contracts/socialV1';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import type { MusicShareDocument } from '../src/repositories/social/musicShareDocuments';
import type { ListeningStateDocument } from '../src/repositories/social/listeningDocuments';
import type {
    SocialBudgetDocument, SocialProfileDocument, SocialRelationshipDocument, SocialReportDocument
} from '../src/repositories/social/socialDocuments';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let now = Date.now();
let service: SocialApi;
let moderation: SocialModerationApi;
const secret = 'synthetic-social-moderation-signing-secret';
const admin = { userId: new ObjectId().toHexString() };
const db = () => getDb()!;
const reports = () => db().collection<SocialReportDocument>('socialReports');
const relationships = () => db().collection<SocialRelationshipDocument>('socialRelationships');
const collections = ['users', 'authSessions', 'socialProfiles', 'socialRelationships', 'socialMutations', 'socialOutbox',
    'socialBudgets', 'socialHandles', 'socialReports', 'socialMusicShares', 'socialListeningStates', 'socialListeningPublications'];
const socialService = (options: SocialServiceOptions = {}) => createSocialService({ now: () => now, enabled: () => true, secret: () => secret, ...options });

before(async () => { harness = await startMongoReplicaSet('archtree-social-moderation-test'); });
beforeEach(async () => {
    now = Date.now();
    await Promise.all(collections.map(name => db().collection(name).deleteMany({})));
    service = socialService();
    moderation = createSocialModerationService({ now: () => now });
});
after(async () => { await harness?.stop(); });

/** Synthetic accounts carry private fields that must never reach a report view or the target. */
const account = async (name: string): Promise<SocialActor> => {
    const userId = new ObjectId();
    await db().collection('users').insertOne({ _id: userId, email: `${name}@private.invalid`, username: `private-${name}`, role: 'user' });
    const sessionId = await AuthSession.create(userId.toHexString(), `synthetic-refresh-${randomUUID()}`, new Date(now + 30 * SOCIAL_LIMITS.scopeMs));
    return { userId: userId.toHexString(), sessionId };
};
type CommandBody = SocialCommand extends infer C ? C extends SocialCommand ? Omit<C, 'scopeToken' | 'commandId'> : never : never;
const command = (scope: SocialScope, body: CommandBody): SocialCommand => ({ ...body, scopeToken: scope.scopeToken, commandId: randomUUID() }) as SocialCommand;
const member = async (name: string, discoverable = true) => {
    const actor = await account(name);
    const scope = await service.issueScope(actor);
    assert.equal((await service.mutate(actor, command(scope, { action: 'profile', expectedRevision: 0, handle: name, alias: `Alias ${name}`, discoverable }))).outcome, 'applied');
    return { actor, scope, profile: (await service.ownProfile(actor))! };
};
type Member = Awaited<ReturnType<typeof member>>;
const report = (from: Member, to: Member | string, extra: { reason?: 'impersonation' | 'harassment' | 'spam' | 'inappropriate' | 'other'; note?: string } = {}) =>
    service.mutate(from.actor, command(from.scope, { action: 'report', targetSocialId: typeof to === 'string' ? to : to.profile.socialId,
        reason: extra.reason ?? 'other', note: extra.note ?? '' }));
const request = async (from: Member, to: Member) => service.mutate(from.actor, command(from.scope, { action: 'request',
    targetSocialId: to.profile.socialId, expectedRevision: (await service.relationship(from.actor, to.profile.socialId))?.revision ?? 0 }));
const friendship = async (a: Member, b: Member) => {
    assert.equal((await request(a, b)).outcome, 'applied');
    const incoming = (await service.relationship(b.actor, a.profile.socialId))!;
    assert.equal((await service.mutate(b.actor, command(b.scope, { action: 'accept', targetSocialId: a.profile.socialId, expectedRevision: incoming.revision }))).outcome, 'applied');
};
const pair = (a: Member, b: Member) => relationships().findOne({ _id: [a.actor.userId, b.actor.userId].sort().join(':') });
const outbox = async (who: Member) => (await db().collection('socialOutbox').findOne({ _id: who.actor.userId }))?.revision ?? 0;
const socialError = (statusCode: number, code: string) => (error: unknown) =>
    error instanceof SocialError && error.statusCode === statusCode && error.code === code;

test('a report is status-only, invisible to its target and deduplicated per reporter, target and UTC day', async () => {
    const alice = await member('alice');
    const mallory = await member('mallory');
    const targetOutbox = await outbox(mallory);
    const targetProfile = await db().collection('socialProfiles').findOne({ _id: mallory.profile.socialId });
    const first = command(alice.scope, { action: 'report', targetSocialId: mallory.profile.socialId, reason: 'impersonation', note: 'Pretends to be staff' });
    assert.deepEqual(await service.mutate(alice.actor, first), { commandId: first.commandId, outcome: 'applied', replayed: false });
    const [stored] = await reports().find().toArray();
    assert.ok(stored);
    assert.match(stored._id, /^rp_[a-f0-9]{32}$/);
    assert.deepEqual({ ...stored, _id: undefined, dedupeKey: undefined, createdAt: undefined }, {
        _id: undefined, dedupeKey: undefined, createdAt: undefined,
        reporterAccountId: alice.actor.userId, reporterSocialId: alice.profile.socialId,
        targetAccountId: mallory.actor.userId, targetSocialId: mallory.profile.socialId, targetHandle: 'mallory', targetAlias: 'Alias mallory',
        reason: 'impersonation', note: 'Pretends to be staff', state: 'open'
    });
    // Nothing about the target changes: no invalidation, receipt, profile write or relationship.
    assert.equal(await outbox(mallory), targetOutbox);
    assert.equal(await db().collection('socialMutations').countDocuments({ accountId: mallory.actor.userId }), 1);
    assert.deepEqual(await db().collection('socialProfiles').findOne({ _id: mallory.profile.socialId }), targetProfile);
    assert.equal(await pair(alice, mallory), null);
    assert.deepEqual(await service.relationship(mallory.actor, alice.profile.socialId), { socialId: alice.profile.socialId, state: 'none', revision: 0 });

    assert.deepEqual(await service.mutate(alice.actor, first), { commandId: first.commandId, outcome: 'applied', replayed: true });
    assert.equal((await report(alice, mallory, { reason: 'spam' })).outcome, 'noop');
    assert.equal(await reports().countDocuments(), 1);
    const budget = await db().collection<SocialBudgetDocument>('socialBudgets').findOne({ _id: alice.actor.userId });
    assert.equal(budget?.reports, 1);
    now += SOCIAL_LIMITS.scopeMs;
    alice.scope = await service.issueScope(alice.actor);
    assert.equal((await report(alice, mallory, { reason: 'spam' })).outcome, 'applied');
    assert.equal(await reports().countDocuments(), 2);

    const page = await moderation.listReports({ state: 'open', limit: 10 });
    assert.deepEqual(page.items.map(item => item.reason), ['impersonation', 'spam']);
    assert.deepEqual(page.items[0].reporter, { socialId: alice.profile.socialId, handle: 'alice' });
    assert.equal(page.items[0].reported.current?.openReports, 2);
    const json = JSON.stringify(page);
    for (const privateValue of [alice.actor.userId, mallory.actor.userId, '@private.invalid', 'synthetic-refresh', 'dedupeKey', 'accountId']) {
        assert.equal(json.includes(privateValue), false, privateValue);
    }
});

test('reports cover blocked and inactive pairs and survive disabled admission, but never self, unknown or profile-less reporters', async () => {
    const alice = await member('alice');
    const mallory = await member('mallory');
    const bobby = await member('bobby');
    const carol = await member('carol');
    assert.equal((await service.mutate(alice.actor, command(alice.scope, { action: 'block', targetSocialId: mallory.profile.socialId }))).outcome, 'applied');
    assert.equal((await report(alice, mallory)).outcome, 'applied');
    assert.equal((await service.mutate(mallory.actor, command(mallory.scope, { action: 'block', targetSocialId: bobby.profile.socialId }))).outcome, 'applied');
    assert.equal((await report(bobby, mallory)).outcome, 'applied');
    assert.equal((await service.mutate(carol.actor, command(carol.scope, { action: 'deactivate' }))).outcome, 'applied');
    assert.equal((await report(carol, mallory)).outcome, 'applied');
    for (const target of [alice, `s_${'f'.repeat(32)}`]) {
        const result = await report(alice, target);
        assert.equal(result.outcome, 'rejected');
        assert.equal(result.code, 'profile_unavailable');
    }
    const outsider = await account('outsider');
    const outsiderScope = await service.issueScope(outsider);
    const missing = await service.mutate(outsider, command(outsiderScope, { action: 'report', targetSocialId: mallory.profile.socialId, reason: 'other', note: '' }));
    assert.equal(missing.outcome, 'rejected');
    assert.equal(missing.code, 'profile_unavailable');
    assert.equal(await reports().countDocuments(), 3);

    const disabled = socialService({ enabled: () => false });
    const dave = await member('dave');
    assert.equal((await disabled.mutate(dave.actor, command(dave.scope, { action: 'report', targetSocialId: mallory.profile.socialId, reason: 'spam', note: '' }))).outcome, 'applied');
});

test('the daily report allowance is durable, spent only by new reports and renewed the next UTC day', async () => {
    const dave = await member('dave');
    const mallory = await member('mallory');
    const day = Math.floor(now / SOCIAL_LIMITS.scopeMs);
    await db().collection<SocialBudgetDocument>('socialBudgets').updateOne({ _id: dave.actor.userId },
        { $set: { accountId: dave.actor.userId, reportDay: day, reports: SOCIAL_LIMITS.reportsPerDay } }, { upsert: true });
    const limited = await report(dave, mallory);
    assert.deepEqual([limited.outcome, limited.code], ['rejected', 'social_limit']);
    assert.equal(await reports().countDocuments(), 0);
    now += SOCIAL_LIMITS.scopeMs;
    dave.scope = await service.issueScope(dave.actor);
    assert.equal((await report(dave, mallory)).outcome, 'applied');
    assert.equal((await db().collection<SocialBudgetDocument>('socialBudgets').findOne({ _id: dave.actor.userId }))?.reports, 1);
});

test('suspension hides the listener, cancels requests, clears shares and listening, and resolves open reports', async () => {
    const mallory = await member('mallory');
    const alice = await member('alice');
    const bobby = await member('bobby');
    const carol = await member('carol');
    const dave = await member('dave');
    await friendship(alice, mallory);
    assert.equal((await request(mallory, bobby)).outcome, 'applied');
    assert.equal((await request(carol, mallory)).outcome, 'applied');
    assert.equal((await report(alice, mallory, { reason: 'harassment', note: 'Abusive name' })).outcome, 'applied');
    await db().collection<MusicShareDocument>('socialMusicShares').insertOne({ _id: `ms_${'1'.repeat(32)}`, senderAccountId: mallory.actor.userId,
        recipientAccountId: alice.actor.userId, accountIds: [mallory.actor.userId, alice.actor.userId].sort(), contentType: 'audioTrack',
        contentId: new ObjectId().toHexString(), createdAt: new Date(now), expiresAt: new Date(now + 30 * SOCIAL_LIMITS.scopeMs) });
    await db().collection<ListeningStateDocument>('socialListeningStates').insertOne({ _id: mallory.actor.userId, accountId: mallory.actor.userId,
        enabled: true, revision: 1, publisherRevision: 1, updatedAt: new Date(now) });
    const before = { alice: await outbox(alice), bobby: await outbox(bobby), carol: await outbox(carol), dave: await outbox(dave) };
    const friendshipRow = await pair(alice, mallory);

    const suspended = await moderation.suspend(admin, mallory.profile.socialId);
    assert.equal(suspended.outcome, 'applied');
    assert.equal(suspended.value.status, 'suspended');
    assert.equal(suspended.value.openReports, 0);
    assert.equal(suspended.value.suspendedAt, new Date(now).toISOString());

    // Hidden from every other listener.
    assert.equal(await service.lookup(dave.actor, 'mallory'), null);
    assert.deepEqual((await service.list(alice.actor, 'friends', 20)).items, []);
    assert.equal(await service.relationship(alice.actor, mallory.profile.socialId), null);
    assert.deepEqual((await service.list(bobby.actor, 'incoming', 20)).items, []);
    assert.deepEqual((await service.list(carol.actor, 'outgoing', 20)).items, []);
    assert.deepEqual((await service.musicShares(alice.actor, 'incoming', 20)).items, []);
    // Accepted friendship is retained unchanged; both pending requests ended.
    assert.deepEqual(await pair(alice, mallory), friendshipRow);
    for (const peer of [bobby, carol]) {
        const row = await pair(mallory, peer);
        assert.equal(row?.state, 'none');
        assert.equal(row?.requestedBy, undefined);
    }
    assert.equal(await db().collection('socialMusicShares').countDocuments(), 0);
    assert.equal((await db().collection<ListeningStateDocument>('socialListeningStates').findOne({ _id: mallory.actor.userId }))?.enabled, false);
    const resolved = (await reports().find().toArray())[0];
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.resolution, 'suspended');
    assert.equal(resolved.resolvedBy, admin.userId);
    assert.equal(resolved.expiresAt?.getTime(), now + SOCIAL_MODERATION_LIMITS.resolvedRetentionMs);
    assert.ok(await outbox(alice) > before.alice && await outbox(bobby) > before.bobby && await outbox(carol) > before.carol);
    assert.equal(await outbox(dave), before.dave);

    // The suspended listener sees the suspension, cannot admit anything new, and keeps safety actions.
    const own = (await service.ownProfile(mallory.actor))!;
    assert.deepEqual({ active: own.active, discoverable: own.discoverable, suspended: own.suspended }, { active: false, discoverable: false, suspended: true });
    assert.deepEqual((await service.list(mallory.actor, 'friends', 20)).items, []);
    const reactivate = await service.mutate(mallory.actor, command(mallory.scope, { action: 'profile', expectedRevision: own.revision,
        handle: 'mallory', alias: 'Alias mallory', discoverable: true }));
    assert.deepEqual([reactivate.outcome, reactivate.code], ['rejected', 'social_suspended']);
    assert.equal((await request(mallory, dave)).code, 'profile_unavailable');
    assert.equal((await service.mutate(mallory.actor, command(mallory.scope, { action: 'block', targetSocialId: dave.profile.socialId }))).outcome, 'applied');
    assert.equal((await report(mallory, dave)).outcome, 'applied');
    assert.equal((await moderation.suspend(admin, mallory.profile.socialId)).outcome, 'noop');
    assert.deepEqual((await moderation.listSuspended()).map(profile => profile.handle), ['mallory']);
    assert.equal((await moderation.findProfile('MALLORY'))?.status, 'suspended');

    // Unsuspension restores the listener's own choices and retained friendship, not the cancelled requests.
    const restored = await moderation.unsuspend(admin, mallory.profile.socialId);
    assert.equal(restored.outcome, 'applied');
    assert.equal(restored.value.status, 'active');
    const back = (await service.ownProfile(mallory.actor))!;
    assert.deepEqual({ active: back.active, discoverable: back.discoverable, suspended: back.suspended }, { active: true, discoverable: true, suspended: undefined });
    assert.deepEqual((await service.list(alice.actor, 'friends', 20)).items.map(item => item.socialId), [mallory.profile.socialId]);
    assert.equal((await service.lookup(dave.actor, 'mallory')), null, 'dave was blocked by mallory while suspended');
    assert.equal((await service.lookup(bobby.actor, 'mallory'))?.socialId, mallory.profile.socialId);
    assert.deepEqual((await service.list(bobby.actor, 'incoming', 20)).items, []);
    assert.equal((await service.mutate(mallory.actor, command(mallory.scope, { action: 'profile', expectedRevision: back.revision,
        handle: 'mallory', alias: 'Calmer alias', discoverable: true }))).outcome, 'applied');
    assert.equal((await moderation.unsuspend(admin, mallory.profile.socialId)).outcome, 'noop');
    assert.deepEqual(await moderation.listSuspended(), []);
});

test('unsuspension restores undiscoverable and deactivated choices exactly', async () => {
    const quiet = await member('quiet', false);
    const away = await member('away');
    assert.equal((await service.mutate(away.actor, command(away.scope, { action: 'deactivate' }))).outcome, 'applied');
    for (const who of [quiet, away]) {
        assert.equal((await moderation.suspend(admin, who.profile.socialId)).outcome, 'applied');
        assert.equal((await moderation.unsuspend(admin, who.profile.socialId)).outcome, 'applied');
    }
    const quietProfile = (await service.ownProfile(quiet.actor))!;
    assert.deepEqual([quietProfile.active, quietProfile.discoverable, quietProfile.suspended], [true, false, undefined]);
    const awayProfile = (await service.ownProfile(away.actor))!;
    assert.deepEqual([awayProfile.active, awayProfile.discoverable, awayProfile.suspended], [false, false, undefined]);
    const stored = await db().collection<SocialProfileDocument>('socialProfiles').findOne({ _id: away.profile.socialId });
    assert.equal('suspension' in stored!, false);
    assert.equal((await service.mutate(away.actor, command(away.scope, { action: 'profile', expectedRevision: awayProfile.revision,
        handle: 'away', alias: 'Alias away', discoverable: true }))).outcome, 'applied');
});

test('report resolution is idempotent, report pages are cursor-ordered, and unknown targets are refused', async () => {
    const mallory = await member('mallory');
    const reporters = [await member('alice'), await member('bobby'), await member('carol')];
    for (const reporter of reporters) {
        assert.equal((await report(reporter, mallory)).outcome, 'applied');
        now += 1_000;
    }
    const first = await moderation.listReports({ state: 'open', limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await moderation.listReports({ state: 'open', limit: 2, cursor: first.nextCursor });
    assert.deepEqual([...first.items, ...second.items].map(item => item.reporter?.handle), ['alice', 'bobby', 'carol']);
    assert.equal(second.nextCursor, null);

    const target = first.items[0].reportId;
    const dismissed = await moderation.resolveReport(admin, target, 'dismissed');
    assert.deepEqual([dismissed.outcome, dismissed.value.state, dismissed.value.resolution], ['applied', 'resolved', 'dismissed']);
    now += 1_000;
    const repeated = await moderation.resolveReport(admin, target, 'actioned');
    assert.deepEqual([repeated.outcome, repeated.value.resolution], ['noop', 'dismissed']);
    assert.equal((await moderation.resolveReport(admin, first.items[1].reportId, 'actioned')).value.resolution, 'actioned');
    assert.deepEqual((await moderation.listReports({ state: 'resolved', limit: 10 })).items.map(item => item.reporter?.handle), ['bobby', 'alice']);
    assert.equal((await moderation.listReports({ state: 'open', limit: 10 })).items.length, 1);

    await assert.rejects(moderation.resolveReport(admin, `rp_${'0'.repeat(32)}`, 'dismissed'), socialError(404, 'report_unavailable'));
    await assert.rejects(moderation.resolveReport(admin, 'rp_short', 'dismissed'), socialError(400, 'invalid_request'));
    await assert.rejects(moderation.listReports({ state: 'open', limit: 2, cursor: 'not-a-cursor' }), socialError(400, 'invalid_cursor'));
    await assert.rejects(moderation.suspend(admin, `s_${'0'.repeat(32)}`), socialError(404, 'profile_unavailable'));
    await assert.rejects(moderation.unsuspend(admin, `s_${'0'.repeat(32)}`), socialError(404, 'profile_unavailable'));
    await assert.rejects(moderation.suspend({ userId: 'not-an-admin-id' }, mallory.profile.socialId), socialError(401, 'session_required'));
});

test('deleting a reporter leaves an anonymous report; deleting the target removes every report about it', async () => {
    const alice = await member('alice');
    const mallory = await member('mallory');
    const bobby = await member('bobby');
    assert.equal((await report(alice, mallory, { note: 'Alice wrote this' })).outcome, 'applied');
    assert.equal((await report(mallory, alice)).outcome, 'applied');
    assert.equal((await report(bobby, mallory)).outcome, 'applied');
    const carol = await member('carol');
    assert.equal((await report(alice, carol)).outcome, 'applied');
    // Both of alice's reports are anonymized in one transaction; each gets its own unique key.
    assert.deepEqual(await deleteListenerAccountData(alice.actor.userId), { status: 'deleted' });
    assert.equal(await reports().countDocuments({ dedupeKey: /^anonymized:rp_/ }), 2);
    const remaining = await moderation.listReports({ state: 'open', limit: 10 });
    assert.equal(remaining.items.length, 3);
    const anonymous = remaining.items.find(item => item.reporter === null && item.reported.handle === 'mallory')!;
    assert.equal(anonymous.note, null);
    assert.equal(anonymous.reported.handle, 'mallory');
    assert.equal(remaining.items.find(item => item.reporter !== null)?.reporter?.handle, 'bobby');
    assert.equal(await reports().countDocuments({ targetAccountId: alice.actor.userId }), 0);
    assert.equal(JSON.stringify(await reports().find().toArray()).includes(alice.actor.userId), false);
    assert.deepEqual(await deleteListenerAccountData(mallory.actor.userId), { status: 'deleted' });
    assert.deepEqual((await reports().find().toArray()).map(row => row.targetHandle), ['carol']);
});

test('a friend request racing a suspension never leaves a pending request to the suspended listener', async () => {
    const mallory = await member('mallory');
    const alice = await member('alice');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const racing = socialService({ afterAccountFence: async () => { if (!held) { held = true; enter(); await released; } } });
    const pendingRequest = racing.mutate(alice.actor, command(alice.scope, { action: 'request', targetSocialId: mallory.profile.socialId, expectedRevision: 0 }));
    await entered;
    // The suspension conflicts on mallory's account fence and retries until the request settles.
    const pendingSuspension = moderation.suspend(admin, mallory.profile.socialId);
    setTimeout(release, 50);
    const [requested, suspension] = await Promise.all([pendingRequest, pendingSuspension]);
    assert.equal(suspension.outcome, 'applied');
    assert.ok(requested.outcome === 'applied' || requested.code === 'profile_unavailable');
    assert.notEqual((await pair(alice, mallory))?.state, 'pending');
    assert.deepEqual((await service.list(mallory.actor, 'incoming', 20)).items, []);
});
