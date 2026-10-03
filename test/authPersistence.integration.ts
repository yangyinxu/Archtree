import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import AuthActionToken from '../src/models/authActionToken';
import AuthSession, { AuthSessionDocument } from '../src/models/authSession';
import { PasskeyChallenge } from '../src/models/passkey';
import {
    createSession,
    refreshSession,
    revokeRefreshSession
} from '../src/services/authSessionService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-auth-persistence-test');
});

after(async () => {
    await harness?.stop();
});

test('concurrent reuse of one refresh token leaves exactly one current pair and revocation is immediate', async () => {
    const userId = new ObjectId();
    const user = {
        _id: userId,
        email: 'rotation@example.com',
        password: 'unused-hash',
        username: '',
        posts: [],
        role: 'user'
    };
    await getDb()!.collection('users').insertOne(user);

    const initial = await createSession(user);
    const attempts = await Promise.all(
        Array.from({ length: 8 }, () => refreshSession(initial.refreshToken))
    );
    const issued = attempts.filter(
        (tokens): tokens is NonNullable<typeof tokens> => tokens !== null
    );
    // One attempt rotates the current token; every later one presents the
    // immediately previous token inside its replay window and supersedes the
    // pair issued before it, so only one issued pair stays usable.
    assert.equal(issued.length, 8);
    const hash = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    const stored = await getDb()!.collection<AuthSessionDocument>('authSessions')
        .findOne({ _id: new ObjectId(initial.sessionId) });
    assert.equal(stored?.previousRefreshTokenHash, hash(initial.refreshToken));
    const current = issued.filter(tokens => hash(tokens.refreshToken) === stored?.refreshTokenHash);
    assert.equal(current.length, 1);
    for (const superseded of issued.filter(tokens => tokens !== current[0])) {
        assert.equal(await refreshSession(superseded.refreshToken), null);
    }

    await revokeRefreshSession(current[0].refreshToken);
    assert.equal(await refreshSession(current[0].refreshToken), null);
    assert.equal(await refreshSession(initial.refreshToken), null, 'revocation also ends the replay window');
    assert.equal(await AuthSession.findActiveById(initial.sessionId), null);
});

test('revoke-all-except preserves only the credential-changing device', async () => {
    const userId = new ObjectId().toString();
    await getDb()!.collection('users').insertOne({ _id: new ObjectId(userId), email: `${userId}@example.test`, username: userId });
    const expiry = new Date(Date.now() + 60_000);
    const current = await AuthSession.create(userId, 'hash-current', expiry);
    const otherA = await AuthSession.create(userId, 'hash-other-a', expiry);
    const otherB = await AuthSession.create(userId, 'hash-other-b', expiry);

    await AuthSession.revokeAllExcept(userId, current);

    assert.ok(await AuthSession.findActiveById(current));
    assert.equal(await AuthSession.findActiveById(otherA), null);
    assert.equal(await AuthSession.findActiveById(otherB), null);
});

test('email action codes and passkey challenges are single-use under concurrency', async () => {
    const userId = new ObjectId().toString();
    await getDb()!.collection('users').insertOne({ _id: new ObjectId(userId), email: `${userId}@example.test`, username: userId });
    const code = await AuthActionToken.issue(userId, 'resetPassword', 5);
    const codeAttempts = await Promise.all(
        Array.from(
            { length: 6 },
            () => AuthActionToken.consume(userId, 'resetPassword', code)
        )
    );
    assert.equal(codeAttempts.filter(Boolean).length, 1);

    const flowId = await PasskeyChallenge.issue('authenticate', 'challenge');
    const challengeAttempts = await Promise.all(
        Array.from(
            { length: 6 },
            () => PasskeyChallenge.consume(flowId, 'authenticate')
        )
    );
    assert.equal(challengeAttempts.filter(Boolean).length, 1);
});

test('expired and malformed session identifiers fail closed', async () => {
    const userId = new ObjectId().toString();
    await getDb()!.collection('users').insertOne({ _id: new ObjectId(userId), email: `${userId}@example.test`, username: userId });
    const expired = await AuthSession.create(
        userId,
        'expired-hash',
        new Date(Date.now() - 1_000)
    );
    assert.equal(await AuthSession.findActiveById(expired), null);
    assert.equal(await AuthSession.findActiveById('not-an-object-id'), null);
    assert.equal(await refreshSession(''), null);
    assert.equal(await refreshSession('x'.repeat(513)), null);
});
