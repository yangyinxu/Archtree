import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { ClientSession, Collection, ObjectId } from 'mongodb';
import { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { changePassword, unlinkProvider } from '../src/controllers/accountController';
import { resetPassword, verifyEmail } from '../src/controllers/emailAuthController';
import { authenticateWithGoogle } from '../src/controllers/federatedAuthController';
import { requireAuthWhenPresented } from '../src/middleware/authMiddleware';
import { getDb } from '../src/infrastructure/database';
import AuthActionToken from '../src/models/authActionToken';
import AuthIdentity from '../src/models/authIdentity';
import AuthSession from '../src/models/authSession';
import { Passkey, PasskeyChallenge } from '../src/models/passkey';
import User from '../src/models/user';
import { onRoomChanges } from '../src/realtime/roomEvents';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { AccountReferenceUnavailableError, withActiveAccount } from '../src/services/accountReferenceFenceService';
import { applyEmailAction, changeAccountPassword } from '../src/services/authCredentialService';
import { createSession } from '../src/services/authSessionService';
import { startMongoReplicaSet, MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const originalPepper = process.env.AUTH_CODE_PEPPER;
before(async () => {
    harness = await startMongoReplicaSet('archtree-auth-credential-lifecycle-test');
    process.env.AUTH_CODE_PEPPER = 'synthetic-auth-credential-lifecycle-pepper';
});
after(async () => {
    await harness?.stop();
    if (originalPepper === undefined) delete process.env.AUTH_CODE_PEPPER;
    else process.env.AUTH_CODE_PEPPER = originalPepper;
});

/** Real accounts make each writer's deletion fence part of the test instead of bypassing it. */
const account = async (password = '') => {
    const name = randomUUID();
    const result = await new User(`${name}@example.test`, password, name, [], 'user', '', true).save();
    const user = (await User.findById(result.insertedId.toString()))!;
    return { user, userId: result.insertedId.toString() };
};
const sessionFor = (userId: string) => AuthSession.create(userId, randomUUID(), new Date(Date.now() + 60_000));
const request = (userId: string, sessionId: string, body = {}, params = {}) => ({
    auth: { userId, sessionId, email: 'synthetic@example.test', role: 'user' }, body, params
} as unknown as Request);
const response = () => {
    const result = { statusCode: 200, body: undefined as unknown };
    const res = {
        status(code: number) { result.statusCode = code; return this; },
        json(body: unknown) { result.body = body; return this; },
        send() { return this; }
    } as Response;
    return { result, res };
};
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

/** Fails after session and room writes, exercising rollback of the entire outer credential transaction. */
const failCleanup = (userId: string) => {
    const original = Collection.prototype.deleteMany;
    Collection.prototype.deleteMany = async function (filter, ...args) {
        if (this.collectionName === 'socialRealtimeTickets' && filter?.accountId === userId) {
            throw new Error('Synthetic cleanup failure');
        }
        return original.call(this, filter, ...args);
    } as typeof original;
    return () => { Collection.prototype.deleteMany = original; };
};

test('concurrent Apple and Google unlink retains one recovery method', async () => {
    const { userId } = await account();
    const sessionId = await sessionFor(userId);
    await AuthIdentity.create(userId, 'apple', randomUUID());
    await AuthIdentity.create(userId, 'google', randomUUID());
    const first = response(); const second = response();
    await Promise.all([
        unlinkProvider(request(userId, sessionId, {}, { provider: 'apple' }), first.res),
        unlinkProvider(request(userId, sessionId, {}, { provider: 'google' }), second.res)
    ]);
    assert.deepEqual([first.result.statusCode, second.result.statusCode].sort(), [204, 409]);
    assert.equal((await AuthIdentity.listForUser(userId)).length, 1);
});

test('password reset rolls back code, password and session writes on cleanup failure and retries the same code', async () => {
    const oldHash = await bcrypt.hash('Old-password-739!', 4);
    const { user, userId } = await account(oldHash);
    const sessionId = await sessionFor(userId);
    const code = await AuthActionToken.issue(userId, 'resetPassword', 15);
    const req = { body: { email: user.email, code, password: 'New-password-842!' } } as Request;
    let notifications = 0; const unsubscribe = onRoomChanges(() => { notifications += 1; });
    const restore = failCleanup(userId);
    try {
        await assert.rejects(resetPassword(req, response().res), /Synthetic cleanup failure/);
        assert.equal((await User.findById(userId))!.password, oldHash);
        assert.ok(await AuthSession.findActiveById(sessionId));
        assert.equal((await getDb()!.collection('authActionTokens').findOne({ userId }))!.consumedAt, undefined);
        assert.equal(notifications, 0);
    } finally { restore(); unsubscribe(); }
    const retried = response(); await resetPassword(req, retried.res);
    assert.equal(retried.result.statusCode, 204);
    assert.ok(await bcrypt.compare('New-password-842!', (await User.findById(userId))!.password));
    assert.equal(await AuthSession.findActiveById(sessionId), null);
    const replay = response(); await resetPassword(req, replay.res);
    assert.equal(replay.result.statusCode, 400);
});

test('failure before password persistence preserves the reset code', async () => {
    const { userId } = await account('synthetic-old-hash');
    const code = await AuthActionToken.issue(userId, 'resetPassword', 15);
    const original = User.updatePassword;
    User.updatePassword = async () => { throw new Error('Synthetic password failure'); };
    try { await assert.rejects(applyEmailAction(userId, 'resetPassword', code, 'synthetic-new-hash'), /Synthetic password failure/); }
    finally { User.updatePassword = original; }
    assert.equal(await applyEmailAction(userId, 'resetPassword', code, 'synthetic-new-hash'), true);
});

test('email verification also rolls back consumption when its durable effect fails', async () => {
    const { user, userId } = await account();
    await getDb()!.collection('users').updateOne({ _id: user._id }, { $set: { emailVerified: false } });
    const code = await AuthActionToken.issue(userId, 'verifyEmail', 15);
    const original = User.markEmailVerified;
    User.markEmailVerified = async () => { throw new Error('Synthetic verification failure'); };
    try {
        await assert.rejects(verifyEmail({ body: { email: user.email, code } } as Request, response().res), /Synthetic verification failure/);
    } finally { User.markEmailVerified = original; }
    assert.equal((await User.findById(userId))!.emailVerified, false);
    assert.equal(await applyEmailAction(userId, 'verifyEmail', code), true);
    assert.equal((await User.findById(userId))!.emailVerified, true);
});

test('password change rolls back on cleanup failure and preserves only the caller on retry', async () => {
    const password = 'Current-password-719!'; const oldHash = await bcrypt.hash(password, 4);
    const { userId } = await account(oldHash);
    const current = await sessionFor(userId); const other = await sessionFor(userId);
    const req = request(userId, current, { currentPassword: password, newPassword: 'Next-password-826!' });
    const restore = failCleanup(userId);
    try { await assert.rejects(changePassword(req, response().res), /Synthetic cleanup failure/); }
    finally { restore(); }
    assert.equal((await User.findById(userId))!.password, oldHash);
    assert.ok(await AuthSession.findActiveById(current)); assert.ok(await AuthSession.findActiveById(other));
    const retry = response(); await changePassword(req, retry.res);
    assert.equal(retry.result.statusCode, 204);
    assert.ok(await AuthSession.findActiveById(current)); assert.equal(await AuthSession.findActiveById(other), null);
});

test('concurrent changes cannot both commit against the same verified password', async () => {
    const { userId } = await account('old-hash'); const current = await sessionFor(userId);
    const results = await Promise.allSettled([
        changeAccountPassword(userId, current, 'old-hash', 'first-hash'),
        changeAccountPassword(userId, current, 'old-hash', 'second-hash')
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.statusCode, 400);
});

test('a session revoked after middleware authorization cannot change credentials or unlink a provider', async () => {
    const { userId } = await account('old-hash'); const current = await sessionFor(userId);
    await AuthIdentity.create(userId, 'apple', randomUUID());
    await AuthSession.revokeById(userId, current);
    await assert.rejects(changeAccountPassword(userId, current, 'old-hash', 'new-hash'), { statusCode: 401 });
    await assert.rejects(unlinkProvider(request(userId, current, {}, { provider: 'apple' }), response().res), { statusCode: 401 });
    assert.equal((await User.findById(userId))!.password, 'old-hash');
    assert.equal((await AuthIdentity.listForUser(userId)).length, 1);
});

test('reset rejects delayed old-password login and revokes a login that committed first', async () => {
    const { user, userId } = await account('old-hash');
    const firstLogin = await createSession(user as any, undefined, 'old-hash');
    const code = await AuthActionToken.issue(userId, 'resetPassword', 15);
    assert.equal(await applyEmailAction(userId, 'resetPassword', code, 'new-hash'), true);
    await assert.rejects(createSession(user as any, undefined, 'old-hash'), { statusCode: 401 });
    assert.equal(await AuthSession.findActiveById(firstLogin.sessionId), null);
    assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId, revokedAt: { $exists: false } }), 0);
});

const writers: Array<{ collection: string; write: (userId: string, session?: ClientSession) => Promise<unknown> }> = [
    { collection: 'authIdentities', write: (id, session) => AuthIdentity.create(id, 'apple', randomUUID(), undefined, session) },
    { collection: 'authSessions', write: (id, session) => AuthSession.create(id, randomUUID(), new Date(Date.now() + 60_000), undefined, undefined, session) },
    { collection: 'authActionTokens', write: (id, session) => AuthActionToken.issue(id, 'resetPassword', 15, session) },
    { collection: 'passkeys', write: (id, session) => Passkey.create({ userId: id, credentialId: randomUUID(), publicKey: 'synthetic',
        counter: 0, transports: [], deviceType: 'singleDevice', backedUp: false }, session) },
    { collection: 'passkeyChallenges', write: (id, session) => PasskeyChallenge.issue('register', 'synthetic-challenge', id, session) }
];
for (const writer of writers) {
    test(`${writer.collection}: deletion wins the account fence and the delayed writer fails closed`, async () => {
        const { userId } = await account();
        let writeResult: Promise<unknown> | undefined;
        const deletion = await deleteListenerAccountData(userId, {
            afterAccountFence: async () => {
                // The delete already owns the conflicting account write before this writer starts.
                writeResult = writer.write(userId).then(() => 'unexpected success', error => error);
            }
        });
        assert.equal(deletion.status, 'deleted');
        assert.ok(await writeResult instanceof AccountReferenceUnavailableError);
        assert.equal(await getDb()!.collection(writer.collection).countDocuments({ userId }), 0);
    });
    test(`${writer.collection}: writer wins, composes without nested transactions, and deletion removes its committed row`, async () => {
        const { userId } = await account();
        const written = deferred(); const release = deferred(); const deletionStarted = deferred();
        const write = withActiveAccount(userId, async session => {
            await writer.write(userId, session);
            written.resolve(); await release.promise;
        });
        await written.promise;
        const deletion = deleteListenerAccountData(userId, { beforeAccountFence: async () => { deletionStarted.resolve(); } });
        await deletionStarted.promise; release.resolve();
        await write; assert.equal((await deletion).status, 'deleted');
        assert.equal(await getDb()!.collection(writer.collection).countDocuments({ userId }), 0);
    });
}

test('discoverable authentication challenges remain accountless', async () => {
    const flowId = await PasskeyChallenge.issue('authenticate', 'synthetic-discoverable');
    assert.ok(await PasskeyChallenge.consume(flowId, 'authenticate'));
    assert.equal(await PasskeyChallenge.consume(flowId, 'authenticate'), null);
});

test('an authorized provider-link request paused across deletion cannot recreate auth data; a new signup still completes', async () => {
    const { user, userId } = await account();
    const tokens = await createSession(user as any);
    const req = {
        body: { identityToken: 'synthetic-verified-google-token', nonce: 'synthetic-nonce' },
        get(name: string) { return name === 'Authorization' ? `Bearer ${tokens.accessToken}` : undefined; }
    } as Request;
    let authorized = false;
    await requireAuthWhenPresented(req, response().res, error => { assert.ifError(error); authorized = true; });
    assert.equal(authorized, true);
    const originalVerifier = OAuth2Client.prototype.verifyIdToken;
    const originalAudience = process.env.GOOGLE_CLIENT_IDS;
    const originalFind = User.findById;
    const subject = randomUUID();
    const reached = deferred(); const release = deferred(); let paused = false;
    process.env.GOOGLE_CLIENT_IDS = 'synthetic-google-client';
    // Only the external provider boundary is stubbed. Middleware, controllers,
    // deletion and every local database write retain their production behavior.
    OAuth2Client.prototype.verifyIdToken = (async () => ({ getPayload: () => ({
        sub: subject, email: user.email, email_verified: true, nonce: 'synthetic-nonce'
    }) })) as typeof originalVerifier;
    User.findById = async (id, session) => {
        const result = await originalFind(id, session);
        if (id === userId && !session && !paused) {
            paused = true; reached.resolve(); await release.promise;
        }
        return result;
    };
    try {
        const linked = response(); let linkError: unknown;
        const pending = authenticateWithGoogle(req, linked.res, error => { linkError = error; });
        await reached.promise;
        assert.equal((await deleteListenerAccountData(userId)).status, 'deleted');
        release.resolve(); await pending;
        assert.ok(linkError instanceof AccountReferenceUnavailableError);
        assert.equal(linked.result.body, undefined);
        assert.equal(await AuthIdentity.find('google', subject), null);
        assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId }), 0);
        const signedOut = response();
        await authenticateWithGoogle({ body: req.body, get: () => undefined } as unknown as Request, signedOut.res, error => { throw error; });
        assert.equal(signedOut.result.statusCode, 200);
        const newUserId = (signedOut.result.body as { userId: string }).userId;
        assert.notEqual(newUserId, userId);
        assert.equal((await AuthIdentity.find('google', subject))!.userId, newUserId);
        assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId: newUserId }), 1);
    } finally {
        release.resolve(); User.findById = originalFind; OAuth2Client.prototype.verifyIdToken = originalVerifier;
        if (originalAudience === undefined) delete process.env.GOOGLE_CLIENT_IDS;
        else process.env.GOOGLE_CLIENT_IDS = originalAudience;
    }
});
