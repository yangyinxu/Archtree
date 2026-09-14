import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import type { SocialOwnProfile, SocialRelationshipView, SocialScope } from '../src/contracts/socialV1';
import type { MusicSharePage } from '../src/contracts/socialMusicV1';
import type { FriendListeningStatus, ListeningReport, ListeningReportResult, OwnListeningState } from '../src/contracts/listeningV1';
import { getDb } from '../src/infrastructure/database';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import AuthSession from '../src/models/authSession';
import { createSession } from '../src/services/authSessionService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let base = '';
const originalEnabled = process.env.FINITUDE_SOCIAL_ENABLED;
const originalLegacy = process.env.ALLOW_LEGACY_AUTH_TOKENS;

before(async () => {
    harness = await startMongoReplicaSet('archtree-social-http-auth-test');
    process.env.FINITUDE_SOCIAL_ENABLED = 'true';
    process.env.ALLOW_LEGACY_AUTH_TOKENS = 'false';
    const app = createApp({ environment: 'test' });
    server = await new Promise<Server>(resolve => {
        const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api/social/v1`;
});
beforeEach(() => { resetRateLimitWindowsForTests(); });
after(async () => {
    await new Promise<void>((resolve, reject) => server ? server.close(error => error ? reject(error) : resolve()) : resolve());
    await harness?.stop();
    if (originalEnabled === undefined) delete process.env.FINITUDE_SOCIAL_ENABLED;
    else process.env.FINITUDE_SOCIAL_ENABLED = originalEnabled;
    if (originalLegacy === undefined) delete process.env.ALLOW_LEGACY_AUTH_TOKENS;
    else process.env.ALLOW_LEGACY_AUTH_TOKENS = originalLegacy;
});

/** Uses the real session issuer and persisted authentication records with synthetic users. */
const account = async () => {
    const id = new ObjectId();
    const user = { _id: id, email: `social-http-${id.toHexString()}@example.test`, role: 'user',
        username: 'Private account username', displayName: 'Private account name', password: 'unused-synthetic-password' };
    await getDb()!.collection('users').insertOne(user);
    const session = await createSession(user);
    return { id, userId: id.toHexString(), email: user.email, token: session.accessToken, sessionId: session.sessionId };
};
type Account = Awaited<ReturnType<typeof account>>;

/** Sends actual HTTP requests through createApp without replacing any auth or social dependency. */
const request = (who: Account, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const json = async <T>(response: Response, status = 200): Promise<T> => {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    return await response.json() as T;
};
const scopeFor = async (who: Account) => json<SocialScope>(await request(who, '/mutation-scopes', {}));
let commandCounter = 0;
const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: `http-social-command-${++commandCounter}` });
const profileFor = async (who: Account) => {
    const scope = await scopeFor(who);
    await json(await request(who, '/me/profile', { ...identity(scope), expectedRevision: 0,
        handle: `u_${who.userId.slice(-20)}`, alias: 'Public social alias', discoverable: true }, 'PATCH'));
    const result = await json<{ profile: SocialOwnProfile }>(await request(who, '/me/profile'));
    assert.ok(result.profile);
    return { ...result.profile, scope };
};
const relationship = async (who: Account, socialId: string) =>
    (await json<{ relationship: SocialRelationshipView | null }>(await request(who, `/relationships/${socialId}`))).relationship;

/** Guards transport rejection with persisted state, not an in-memory service-call counter. */
const socialState = async (accountIds: string[]) => {
    const state: Record<string, unknown[]> = {};
    for (const name of ['socialProfiles', 'socialMutations', 'socialBudgets', 'socialOutbox', 'socialHandles',
        'socialListeningStates', 'socialListeningPublications']) {
        state[name] = await getDb()!.collection(name).find({ accountId: { $in: accountIds } }).sort({ _id: 1 }).toArray();
    }
    state.socialRelationships = await getDb()!.collection('socialRelationships')
        .find({ accountIds: { $in: accountIds } }).sort({ _id: 1 }).toArray();
    return state;
};

const ownListening = async (who: Account) => (await json<{ listening: OwnListeningState }>(await request(who, '/me/listening'))).listening;
const listeningStatuses = async (who: Account, socialIds: string[]) =>
    (await json<{ items: FriendListeningStatus[] }>(await request(who, '/listening-status/query', { socialIds }))).items;
const readyListeningAudio = async (title: string) => {
    const id = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id: id, title, s3Key: id.toHexString(), mediaType: 'audio',
        uploadStatus: 'ready', publicationStatus: 'ready' });
    return id.toHexString();
};
const listeningFriends = async (publisher: Account, friend: Account) => {
    const from = await profileFor(publisher); const to = await profileFor(friend);
    await json(await request(publisher, '/friend-requests', { ...identity(from.scope), targetSocialId: to.socialId, expectedRevision: 0 }));
    await json(await request(friend, `/relationships/${from.socialId}/accept`, {
        ...identity(to.scope), expectedRevision: (await relationship(friend, from.socialId))!.revision }));
    return { from, to };
};

/** A claim's original command ID is its private publication identity; the owner clock supplies the next fence. */
const claimListening = async (who: Account, scope: SocialScope, clientId: string) => {
    const current = await ownListening(who);
    const command = { ...identity(scope), clientId, expectedPreferenceRevision: current.revision,
        expectedPublisherRevision: current.publisherRevision };
    const result = await json<{ outcome: string }>(await request(who, '/listening-publications/claim', command));
    assert.equal(result.outcome, 'applied');
    return { clientId, publicationId: command.commandId, expectedPreferenceRevision: current.revision,
        expectedPublisherRevision: current.publisherRevision + 1 };
};
type ListeningClaim = Awaited<ReturnType<typeof claimListening>>;
const playingReport = (claim: ListeningClaim, mediaTrackId: string, suffix = 'original'): ListeningReport => ({ ...claim,
    sequence: 1, state: 'playing', observedAtMs: Date.now(), playback: { sourceId: `http-listening-source-${suffix}`,
        occurrenceId: `http-listening-occurrence-${suffix}`, mediaTrackId, positionMs: 1000, room: null } });

test('real listening HTTP defaults off and exposes only opted-in current friend Audio after explicit reporting', async () => {
    const publisher = await account(); const friend = await account(); const outsider = await account();
    const { from } = await listeningFriends(publisher, friend); await profileFor(outsider);
    const mediaTrackId = await readyListeningAudio('Public listening Audio');
    const initial = await ownListening(publisher);
    assert.deepEqual({ ...initial, serverTimeMs: 0 }, { enabled: false, revision: 0, publisherRevision: 0, serverTimeMs: 0 });
    assert.deepEqual(await listeningStatuses(friend, [from.socialId]), []);
    await json(await request(publisher, '/me/listening', { ...identity(from.scope), enabled: true, expectedRevision: initial.revision }, 'PATCH'));
    const enabled = await ownListening(publisher); assert.equal(enabled.enabled, true); assert.equal(enabled.revision, 1);
    const claim = await claimListening(publisher, from.scope, 'http-listening-device-original');
    assert.deepEqual(await listeningStatuses(friend, [from.socialId]), []);
    const report = playingReport(claim, mediaTrackId);
    const accepted = await json<ListeningReportResult>(await request(publisher, '/listening-publications/report', report));
    assert.equal(accepted.accepted, true); assert.ok(accepted.expiresAtMs! > accepted.serverTimeMs);
    const visible = await listeningStatuses(friend, [from.socialId]);
    assert.equal(visible.length, 1);
    assert.deepEqual(Object.keys(visible[0]).sort(), ['expiresAtMs', 'peer', 'track']);
    assert.deepEqual(Object.keys(visible[0].peer).sort(), ['alias', 'handle', 'iconSeed', 'socialId']);
    assert.deepEqual(Object.keys(visible[0].track).sort(), ['artistNames', 'artworkUrl', 'contentType', 'id', 'title']);
    assert.equal(visible[0].track.title, 'Public listening Audio'); assert.equal(visible[0].track.contentType, 'audioTrack');
    const encoded = JSON.stringify(visible);
    for (const privateValue of [publisher.userId, publisher.sessionId, friend.userId, friend.sessionId, claim.clientId, claim.publicationId])
        assert.equal(encoded.includes(privateValue), false);
    assert.doesNotMatch(encoded, /positionMs|roomId|occurrenceId|sourceId|sessionId|lastSeen|s3Key|streamUrl/);
    assert.deepEqual(await listeningStatuses(outsider, [from.socialId]), []);
    if (report.state !== 'playing') throw new Error('Fixture must be playing.');
    const stopped = await json<ListeningReportResult>(await request(publisher, '/listening-publications/report', {
        ...claim, sequence: 2, state: 'stopped', playbackSequence: 1, occurrenceId: report.playback.occurrenceId }));
    assert.equal(stopped.accepted, true);
    assert.deepEqual(await listeningStatuses(friend, [from.socialId]), []);
    await json(await request(publisher, '/me/listening', { ...identity(from.scope), enabled: false, expectedRevision: enabled.revision }, 'PATCH'));
    assert.equal((await ownListening(publisher)).enabled, false);
    assert.equal(await getDb()!.collection('socialListeningPublications').countDocuments({ accountId: publisher.userId }), 0);
});

test('real sessions fence listening publisher replacement so old stops and revoked sessions cannot hide or recreate the winner', async () => {
    const publisher = await account(); const friend = await account();
    const { from } = await listeningFriends(publisher, friend);
    await json(await request(publisher, '/me/listening', { ...identity(from.scope), enabled: true, expectedRevision: 0 }, 'PATCH'));
    const firstClaim = await claimListening(publisher, from.scope, 'http-listening-device-first');
    const first = playingReport(firstClaim, await readyListeningAudio('First publisher Audio'), 'first');
    assert.equal((await json<ListeningReportResult>(await request(publisher, '/listening-publications/report', first))).accepted, true);
    const nextSession = await createSession({ _id: publisher.id, email: publisher.email, role: 'user' });
    const replacement = { ...publisher, token: nextSession.accessToken, sessionId: nextSession.sessionId };
    const secondClaim = await claimListening(replacement, await scopeFor(replacement), 'http-listening-device-second');
    const second = playingReport(secondClaim, await readyListeningAudio('Second publisher Audio'), 'second');
    assert.equal((await json<ListeningReportResult>(await request(replacement, '/listening-publications/report', second))).accepted, true);
    if (first.state !== 'playing') throw new Error('Fixture must be playing.');
    assert.equal((await json<ListeningReportResult>(await request(publisher, '/listening-publications/report', {
        ...firstClaim, sequence: 2, state: 'stopped', playbackSequence: 1, occurrenceId: first.playback.occurrenceId }))).accepted, false);
    assert.equal((await listeningStatuses(friend, [from.socialId]))[0].track.title, 'Second publisher Audio');
    await AuthSession.revokeById(publisher.userId, publisher.sessionId);
    assert.equal((await request(publisher, '/listening-publications/report', first)).status, 401);
    assert.equal((await listeningStatuses(friend, [from.socialId]))[0].track.title, 'Second publisher Audio');
    await AuthSession.revokeById(replacement.userId, replacement.sessionId);
    assert.deepEqual(await listeningStatuses(friend, [from.socialId]), []);
    assert.equal((await request(replacement, '/me/listening')).status, 401);
    assert.equal((await request(replacement, '/listening-publications/report', second)).status, 401);
});

test('real listening cookies require origin and current viewer before any body, publication or preference work', async () => {
    const owner = await account(); const other = await account(); const profile = await profileFor(owner);
    const origin = new URL(base).origin;
    const cookie = { Cookie: `session_token=${owner.token}`, 'X-Finitude-Account-Viewer': owner.userId, 'Content-Type': 'application/json' };
    const report = playingReport({ clientId: 'http-listening-device-cookie', publicationId: 'http-listening-publication-cookie',
        expectedPreferenceRevision: 1, expectedPublisherRevision: 1 }, new ObjectId().toHexString());
    const original = await socialState([owner.userId, other.userId]);
    const bodies = [
        { path: '/me/listening', method: 'PATCH', body: { ...identity(profile.scope), enabled: true, expectedRevision: 0 } },
        { path: '/listening-publications/claim', method: 'POST', body: { ...identity(profile.scope), clientId: report.clientId,
            expectedPreferenceRevision: 1, expectedPublisherRevision: 0 } },
        { path: '/listening-publications/report', method: 'POST', body: report },
        { path: '/listening-status/query', method: 'POST', body: { socialIds: [profile.socialId] } }
    ];
    for (const { path, method, body } of bodies) {
        for (const untrusted of [undefined, 'https://untrusted.example.test']) {
            const response = await fetch(`${base}${path}`, { method, headers: { ...cookie, ...(untrusted ? { Origin: untrusted } : {}) }, body: JSON.stringify(body) });
            assert.equal(response.status, 403);
        }
        const stale = await fetch(`${base}${path}`, { method, headers: { ...cookie, Origin: origin,
            'X-Finitude-Account-Viewer': other.userId }, body: `{"private":"${'x'.repeat(8_000)}` });
        assert.equal(stale.status, 409);
        const anonymous = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(anonymous.status, 401);
    }
    assert.equal((await request(owner, '/me/listening', { ...identity(profile.scope), enabled: true, expectedRevision: 0, accountId: other.userId }, 'PATCH')).status, 400);
    assert.equal((await request(owner, '/listening-publications/report', { ...report, accountId: other.userId })).status, 400);
    assert.equal((await request(owner, '/listening-status/query', { socialIds: [profile.socialId], accountId: other.userId })).status, 400);
    assert.equal((await request(owner, '/listening-publications/report', { ...report, extra: 'x'.repeat(8_000) })).status, 413);
    assert.deepEqual(await socialState([owner.userId, other.userId]), original);
    const allowed = await fetch(`${base}/me/listening`, { method: 'PATCH', headers: { ...cookie, Origin: origin },
        body: JSON.stringify({ ...identity(profile.scope), enabled: true, expectedRevision: 0 }) });
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store');
    const read = await fetch(`${base}/me/listening`, { headers: cookie });
    assert.equal(read.status, 200); assert.equal(read.headers.get('X-Finitude-Account-Viewer'), owner.userId);
    assert.equal((await json<{ listening: OwnListeningState }>(read)).listening.enabled, true);
});

test('real bearer sessions permit social work and revocation, expiry, ownership mismatch and account removal deny it', async () => {
    const owner = await account();
    assert.deepEqual(await json(await request(owner, '/me/profile')), { profile: null });
    const profile = await profileFor(owner);
    assert.deepEqual(Object.keys(profile).filter(key => key !== 'scope').sort(),
        ['active', 'alias', 'discoverable', 'handle', 'iconSeed', 'revision', 'socialId']);
    await AuthSession.revokeById(owner.userId, owner.sessionId);
    assert.equal((await request(owner, '/me/profile')).status, 401);
    assert.equal((await request(owner, '/me/deactivate', identity(profile.scope))).status, 401);
    assert.equal((await getDb()!.collection('socialProfiles').findOne({ accountId: owner.userId }))?.active, true);

    const expired = await account();
    await getDb()!.collection('authSessions').updateOne({ _id: new ObjectId(expired.sessionId) }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await request(expired, '/mutation-scopes', {})).status, 401);
    const removed = await account();
    await getDb()!.collection('users').deleteOne({ _id: removed.id });
    assert.equal((await request(removed, '/me/profile')).status, 401);
    const other = await account();
    const mismatchedToken = jwt.sign({ userId: other.userId, email: other.email, tokenType: 'access',
        sessionId: owner.sessionId }, process.env.JWT_SECRET!, { expiresIn: 60 });
    assert.equal((await request({ ...other, token: mismatchedToken }, '/me/profile')).status, 401);
});

test('real music-share HTTP is account-fenced, friendship-scoped and passive until an explicit owner mutation', async () => {
    const sender = await account(); const recipient = await account(); const outsider = await account();
    const from = await profileFor(sender); const to = await profileFor(recipient); await profileFor(outsider);
    await json(await request(sender, '/friend-requests', { ...identity(from.scope), targetSocialId: to.socialId, expectedRevision: 0 }));
    await json(await request(recipient, `/relationships/${from.socialId}/accept`, { ...identity(to.scope), expectedRevision: (await relationship(recipient, from.socialId))!.revision }));
    const contentId = new ObjectId();
    await getDb()!.collection('audioTracks').insertOne({ _id: contentId, title: 'Explicitly shared public track', s3Key: contentId.toHexString(),
        mediaType: 'audio', uploadStatus: 'ready', publicationStatus: 'ready' });
    const intent = { ...identity(from.scope), targetSocialId: to.socialId, expectedRevision: (await relationship(sender, to.socialId))!.revision,
        contentType: 'audioTrack', contentId: contentId.toHexString() };
    const outcome = await json<{ outcome: string }>(await request(sender, '/music-shares', intent)); assert.equal(outcome.outcome, 'applied');
    const received = await json<MusicSharePage>(await request(recipient, '/music-shares?direction=incoming'));
    assert.equal(received.items.length, 1); assert.equal(received.items[0].peer.socialId, from.socialId);
    assert.equal(received.items[0].content?.title, 'Explicitly shared public track');
    assert.deepEqual((await json<MusicSharePage>(await request(outsider, '/music-shares?direction=incoming'))).items, []);
    for (const privateId of [sender.userId, recipient.userId, sender.sessionId, recipient.sessionId]) assert.equal(JSON.stringify(received).includes(privateId), false);
    const cookie = { Cookie: `session_token=${recipient.token}`, 'X-Finitude-Account-Viewer': recipient.userId };
    const path = `${base}/music-shares?direction=incoming`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { headers: { ...cookie, 'X-Finitude-Account-Viewer': sender.userId } })).status, 409);
    const privateResponse = await fetch(path, { headers: cookie }); assert.equal(privateResponse.status, 200);
    assert.equal(privateResponse.headers.get('Cache-Control'), 'private, no-store');
    const dismissPath = `${base}/music-shares/${received.items[0].shareId}/dismiss`;
    assert.equal((await fetch(dismissPath, { method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(identity(to.scope)) })).status, 403);
    assert.equal((await json<MusicSharePage>(await request(recipient, '/music-shares?direction=incoming'))).items.length, 1);
    await json(await request(recipient, `/music-shares/${received.items[0].shareId}/dismiss`, identity(to.scope)));
    assert.deepEqual((await json<MusicSharePage>(await request(sender, '/music-shares?direction=outgoing'))).items, []);
    await AuthSession.revokeById(recipient.userId, recipient.sessionId);
    assert.equal((await request(recipient, '/music-shares?direction=incoming')).status, 401);
});

test('real cookie authentication enforces current viewer and same-origin proof before private mutation work', async () => {
    const owner = await account();
    const other = await account();
    const origin = new URL(base).origin;
    const headers = { Cookie: `session_token=${owner.token}`, 'Content-Type': 'application/json' };
    const original = await socialState([owner.userId, other.userId]);
    for (const viewer of [undefined, other.userId]) {
        const response = await fetch(`${base}/me/profile`, { headers: { ...headers,
            ...(viewer ? { 'X-Finitude-Account-Viewer': viewer } : {}) } });
        assert.equal((await json<{ code: string }>(response, 409)).code, 'account_viewer_mismatch');
    }
    for (const untrustedOrigin of [undefined, 'https://untrusted.example.test']) {
        const response = await fetch(`${base}/mutation-scopes`, { method: 'POST', headers: {
            ...headers, 'X-Finitude-Account-Viewer': owner.userId,
            ...(untrustedOrigin ? { Origin: untrustedOrigin } : {})
        }, body: '{}' });
        await json(response, 403);
    }
    // Even malformed oversized content cannot bypass the earlier account-viewer boundary.
    const stale = await fetch(`${base}/me/profile`, { method: 'PATCH', headers: {
        ...headers, Origin: origin, 'X-Finitude-Account-Viewer': other.userId
    }, body: `{"alias":"${'x'.repeat(8_000)}` });
    assert.equal(stale.status, 409);
    assert.deepEqual(await socialState([owner.userId, other.userId]), original);
    const scopeResponse = await fetch(`${base}/mutation-scopes`, { method: 'POST', headers: {
        ...headers, Origin: origin, 'X-Finitude-Account-Viewer': owner.userId
    }, body: '{}' });
    const scope = await json<SocialScope>(scopeResponse);
    assert.equal(scopeResponse.headers.get('x-finitude-account-viewer'), owner.userId);
    assert.equal(scopeResponse.headers.get('cache-control'), 'private, no-store');
    await json(await fetch(`${base}/me/profile`, { method: 'PATCH', headers: {
        ...headers, Origin: origin, 'X-Finitude-Account-Viewer': owner.userId
    }, body: JSON.stringify({ ...identity(scope), expectedRevision: 0,
        handle: `u_${owner.userId.slice(-20)}`, alias: 'Cookie listener', discoverable: false }) }));
    assert.equal((await getDb()!.collection('socialProfiles').findOne({ accountId: owner.userId }))?.alias, 'Cookie listener');
});

test('legacy JWTs cannot smuggle an arbitrary, revoked, expired or another accounts session into social service', async () => {
    const owner = await account();
    const other = await account();
    const revoked = await createSession({ _id: owner.id, email: owner.email, role: 'user' });
    const expired = await createSession({ _id: owner.id, email: owner.email, role: 'user' });
    await AuthSession.revokeById(owner.userId, revoked.sessionId);
    await getDb()!.collection('authSessions').updateOne({ _id: new ObjectId(expired.sessionId) }, { $set: { expiresAt: new Date(0) } });
    const original = await socialState([owner.userId]);
    process.env.ALLOW_LEGACY_AUTH_TOKENS = 'true';
    try {
        for (const sessionId of [undefined, new ObjectId().toHexString(), other.sessionId, revoked.sessionId, expired.sessionId]) {
            const token = jwt.sign({ userId: owner.userId, email: owner.email,
                ...(sessionId ? { sessionId } : {}) }, process.env.JWT_SECRET!, { expiresIn: 60 });
            const response = await request({ ...owner, token }, '/mutation-scopes', {});
            const result = await json<{ code: string }>(response, 401);
            assert.equal(result.code, sessionId ? 'social_session_required' : 'session_required');
            for (const [path, body] of [['/me/listening', undefined], ['/listening-status/query', { socialIds: [`s_${'a'.repeat(32)}`] }]] as const) {
                const rejected = await json<{ code: string }>(await request({ ...owner, token }, path, body), 401);
                assert.equal(rejected.code, sessionId ? 'social_session_required' : 'session_required');
            }
        }
    } finally { process.env.ALLOW_LEGACY_AUTH_TOKENS = 'false'; }
    assert.deepEqual(await socialState([owner.userId]), original);
});

test('HTTP callers cannot override ownership or borrow another account scope and responses project no private account fields', async () => {
    const owner = await account();
    const other = await account();
    const ownerProfile = await profileFor(owner);
    const otherProfile = await profileFor(other);
    const original = await socialState([owner.userId, other.userId]);
    const stolen = await request(other, '/me/deactivate', identity(ownerProfile.scope));
    assert.equal((await json<{ code: string }>(stolen, 400)).code, 'mutation_scope_invalid');
    const overridden = await request(owner, '/me/deactivate', { ...identity(ownerProfile.scope), accountId: other.userId });
    assert.equal((await json<{ code: string }>(overridden, 400)).code, 'invalid_request');
    const overriddenTarget = await request(owner, `/relationships/${otherProfile.socialId}/block`, {
        ...identity(ownerProfile.scope), targetSocialId: ownerProfile.socialId
    });
    await json(overriddenTarget, 400);
    assert.deepEqual(await socialState([owner.userId, other.userId]), original);
    // Deliberately injected legacy private fields must not flow through the production projection.
    await getDb()!.collection('socialProfiles').updateOne({ accountId: other.userId }, {
        $set: { email: other.email, avatarAssetId: 'synthetic-private-avatar', activity: 'synthetic-private-activity' }
    });
    const lookup = await json<{ profile: Record<string, unknown> }>(await request(owner, `/profiles?handle=${otherProfile.handle}`));
    assert.deepEqual(Object.keys(lookup.profile).sort(), ['alias', 'handle', 'iconSeed', 'socialId']);
    const own = await json<{ profile: Record<string, unknown> }>(await request(other, '/me/profile'));
    assert.deepEqual(Object.keys(own.profile).sort(), ['active', 'alias', 'discoverable', 'handle', 'iconSeed', 'revision', 'socialId']);
    for (const value of [lookup, own]) {
        const encoded = JSON.stringify(value);
        for (const forbidden of [owner.userId, other.userId, other.email, 'synthetic-private-avatar', 'synthetic-private-activity']) {
            assert.equal(encoded.includes(forbidden), false);
        }
    }
});

test('public HTTP relationship views supply fresh preconditions for request after decline or removal before tombstone expiry', async () => {
    const sender = await account();
    const recipient = await account();
    const senderProfile = await profileFor(sender);
    const recipientProfile = await profileFor(recipient);
    const sendRequest = async () => {
        const current = await relationship(sender, recipientProfile.socialId);
        assert.equal(current?.state, 'none');
        const response = await json<{ outcome: string }>(await request(sender, '/friend-requests', {
            ...identity(senderProfile.scope), targetSocialId: recipientProfile.socialId, expectedRevision: current!.revision
        }));
        assert.equal(response.outcome, 'applied');
    };
    await sendRequest();
    let incoming = await relationship(recipient, senderProfile.socialId);
    assert.equal(incoming?.state, 'incoming');
    await json(await request(recipient, `/relationships/${senderProfile.socialId}/decline`, {
        ...identity(recipientProfile.scope), expectedRevision: incoming!.revision
    }));
    const declined = await relationship(sender, recipientProfile.socialId);
    assert.equal(declined?.state, 'none');
    assert.ok(declined!.revision > 0);
    await sendRequest();
    incoming = await relationship(recipient, senderProfile.socialId);
    await json(await request(recipient, `/relationships/${senderProfile.socialId}/accept`, {
        ...identity(recipientProfile.scope), expectedRevision: incoming!.revision
    }));
    const friendship = await relationship(sender, recipientProfile.socialId);
    assert.equal(friendship?.state, 'friends');
    await json(await request(sender, `/relationships/${recipientProfile.socialId}/remove`, {
        ...identity(senderProfile.scope), expectedRevision: friendship!.revision
    }));
    const removed = await relationship(sender, recipientProfile.socialId);
    assert.equal(removed?.state, 'none');
    assert.ok(removed!.revision > declined!.revision);
    await sendRequest();
    assert.equal((await relationship(sender, recipientProfile.socialId))?.state, 'outgoing');
    assert.equal((await relationship(recipient, senderProfile.socialId))?.state, 'incoming');
});

test('public relationship reads hide another accounts block and preserve only the callers own block state', async () => {
    const blocker = await account();
    const target = await account();
    const blockerProfile = await profileFor(blocker);
    const targetProfile = await profileFor(target);
    await json(await request(blocker, `/relationships/${targetProfile.socialId}/block`, identity(blockerProfile.scope)));
    const ownBlock = await relationship(blocker, targetProfile.socialId);
    assert.equal(ownBlock?.state, 'blocked');
    assert.equal(await relationship(target, blockerProfile.socialId), null);
    assert.equal(await relationship(target, `s_${'0'.repeat(32)}`), null);
    assert.deepEqual(await json(await request(target, `/profiles?handle=${blockerProfile.handle}`)), { profile: null });
    await json(await request(blocker, `/relationships/${targetProfile.socialId}/unblock`, {
        ...identity(blockerProfile.scope), expectedRevision: ownBlock!.revision
    }));
    const current = await relationship(blocker, targetProfile.socialId);
    assert.equal(current?.state, 'none');
    assert.ok(current!.revision > ownBlock!.revision);
    const result = await json<{ outcome: string }>(await request(blocker, '/friend-requests', {
        ...identity(blockerProfile.scope), targetSocialId: targetProfile.socialId, expectedRevision: current!.revision
    }));
    assert.equal(result.outcome, 'applied');
});

test('actual app mounting returns JSON for private misses and bounds bodies before any mutation can persist', async () => {
    const owner = await account();
    const scope = await scopeFor(owner);
    const original = await socialState([owner.userId]);
    const missing = await request(owner, '/missing-private-route');
    assert.equal((await json<{ code: string }>(missing, 404)).code, 'not_found');
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
    const large = await request(owner, '/me/deactivate', { ...identity(scope), marker: 'synthetic-body-marker'.repeat(1_000) });
    assert.equal((await json<{ code: string }>(large, 413)).code, 'request_too_large');
    const malformed = await fetch(`${base}/me/deactivate`, { method: 'POST', headers: {
        Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json'
    }, body: '{"private":"synthetic-body-marker"' });
    assert.equal((await json<{ code: string }>(malformed, 400)).code, 'invalid_request');
    const unauthenticated = await fetch(`${base}/me/deactivate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: `{"private":"${'x'.repeat(8_000)}` });
    await json(unauthenticated, 401);
    assert.deepEqual(await socialState([owner.userId]), original);
});

test('social rate denials and health diagnostics retain no private route, account, body or credential content', async t => {
    const owner = await account();
    const logEntries: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
        t.mock.method(console, method, (...args: unknown[]) => { logEntries.push(args.map(String).join(' ')); });
    }
    const marker = 'synthetic-private-http-marker';
    const first = await fetch(`${base}/missing/${owner.userId}?marker=${marker}`, {
        headers: { Authorization: `Bearer ${owner.token}`, 'X-Request-Id': marker }
    });
    assert.equal(first.status, 404);
    assert.notEqual(first.headers.get('x-request-id'), marker);
    await first.arrayBuffer();
    for (let count = 1; count < 120; count += 1) {
        const response = await request(owner, '/missing');
        assert.equal(response.status, 404);
        await response.arrayBuffer();
    }
    const denied = await request(owner, '/missing');
    assert.equal((await json<{ code: string }>(denied, 429)).code, 'rate_limited');
    assert.ok(Number(denied.headers.get('retry-after')) > 0);
    const health = await json<{ requests: { byArea: Record<string, { completed: number }> } }>(
        await fetch(`${new URL(base).origin}/health`));
    assert.ok(health.requests.byArea.other.completed >= 121);
    const diagnosticText = `${JSON.stringify(health.requests)}${logEntries.join('')}`;
    for (const value of [owner.userId, owner.email, owner.token, marker]) assert.equal(diagnosticText.includes(value), false);
});
