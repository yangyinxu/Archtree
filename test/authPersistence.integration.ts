import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import AuthActionToken from '../src/models/authActionToken';
import AuthSession from '../src/models/authSession';
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

test('refresh rotation permits exactly one concurrent use and revocation is immediate', async () => {
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
    const successful = attempts.filter(
        (tokens): tokens is NonNullable<typeof tokens> => tokens !== null
    );
    assert.equal(successful.length, 1);
    assert.equal(await refreshSession(initial.refreshToken), null);

    await revokeRefreshSession(successful[0].refreshToken);
    assert.equal(await refreshSession(successful[0].refreshToken), null);
    assert.equal(await AuthSession.findActiveById(initial.sessionId), null);
});

test('revoke-all-except preserves only the credential-changing device', async () => {
    const userId = new ObjectId().toString();
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
    const expired = await AuthSession.create(
        new ObjectId().toString(),
        'expired-hash',
        new Date(Date.now() - 1_000)
    );
    assert.equal(await AuthSession.findActiveById(expired), null);
    assert.equal(await AuthSession.findActiveById('not-an-object-id'), null);
    assert.equal(await refreshSession(''), null);
    assert.equal(await refreshSession('x'.repeat(513)), null);
});
