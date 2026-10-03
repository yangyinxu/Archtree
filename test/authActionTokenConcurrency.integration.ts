import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import AuthActionToken, { AuthActionPurpose, maxFailedCodeAttempts } from '../src/models/authActionToken';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
const originalPepper = process.env.AUTH_CODE_PEPPER;
const testPepper = 'auth-action-token-concurrency-pepper';

/** Releases every participant together so issue and consume requests overlap. */
const startBarrier = (participantCount: number) => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return async () => {
        arrived += 1;
        if (arrived === participantCount) release();
        await gate;
    };
};

const codeHash = (userId: string, purpose: AuthActionPurpose, code: string) => crypto
    .createHmac('sha256', testPepper)
    .update(`${userId}:${purpose}:${code}`, 'utf8')
    .digest('hex');

const syntheticRegistration = { passwordHash: 'synthetic-bound-hash', displayName: 'Lorem Ipsum', username: 'lorem' };

/** Inserts an unverified account directly so only the token model is under test. */
const unverifiedAccount = async () => {
    const userId = new ObjectId().toHexString();
    await getDb()!.collection('users').insertOne({
        _id: new ObjectId(userId), email: `${userId}@example.test`, username: userId, emailVerified: false
    });
    return userId;
};

const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

before(async () => {
    harness = await startMongoReplicaSet('archtree-auth-action-token-concurrency-test');
    process.env.AUTH_CODE_PEPPER = testPepper;
});

beforeEach(async () => {
    await getDb()!.collection('authActionTokens').deleteMany({});
});

after(async () => {
    await harness?.stop();
    if (originalPepper === undefined) delete process.env.AUTH_CODE_PEPPER;
    else process.env.AUTH_CODE_PEPPER = originalPepper;
});

test('concurrent issuance leaves one current code and at most one successful consume', async () => {
    const userId = await unverifiedAccount();
    const requestCount = 16;
    const beginIssue = startBarrier(requestCount);
    const codes = await Promise.all(Array.from({ length: requestCount }, async () => {
        await beginIssue();
        return (await AuthActionToken.issueVerification(userId, syntheticRegistration))!;
    }));

    const stored = await getDb()!.collection('authActionTokens')
        .find({ userId, purpose: 'verifyEmail' })
        .toArray();
    assert.equal(stored.length, 1);
    assert.equal(typeof stored[0]._id, 'string');
    assert.equal(stored[0].consumedAt, undefined);
    assert.deepEqual(stored[0].registration, syntheticRegistration);

    // Only the last write is current. Find it by hash instead of submitting the
    // stale codes, whose wrong attempts would void it.
    const current = codes.filter(code => codeHash(userId, 'verifyEmail', code) === stored[0].codeHash);
    assert.equal(new Set(current).size, 1);
    const beginConsume = startBarrier(requestCount);
    const results = await Promise.all(Array.from({ length: requestCount }, async () => {
        await beginConsume();
        return AuthActionToken.consume(userId, 'verifyEmail', current[0]);
    }));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean)?.registration, syntheticRegistration);
    const consumed = await getDb()!.collection('authActionTokens').findOne({ userId, purpose: 'verifyEmail' });
    assert.ok(consumed?.consumedAt);
    assert.equal(consumed?.registration, undefined, 'the bound password hash leaves the consumed slot');
});

test('verification codes cannot be issued without bound credentials or for verified accounts', async () => {
    const userId = await unverifiedAccount();
    await assert.rejects(
        (AuthActionToken.issue as (...args: unknown[]) => Promise<string>)(userId, 'verifyEmail', 30),
        /bound registration credentials/
    );
    await getDb()!.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { emailVerified: true } });
    assert.equal(await AuthActionToken.issueVerification(userId, syntheticRegistration), null);
    assert.equal(await AuthActionToken.issueVerification(userId), null);
    assert.equal(await getDb()!.collection('authActionTokens').countDocuments({ userId }), 0);
});

for (const purpose of ['verifyEmail', 'resetPassword'] as const) {
    const issue = async (userId: string) => (purpose === 'verifyEmail'
        ? (await AuthActionToken.issueVerification(userId, syntheticRegistration))!
        : AuthActionToken.issue(userId, purpose, 15));

    test(`${purpose}: a code survives four wrong attempts and the fifth voids it`, async () => {
        const survivorId = await unverifiedAccount();
        const survivor = await issue(survivorId);
        for (let attempt = 1; attempt < maxFailedCodeAttempts; attempt += 1) {
            assert.equal(await AuthActionToken.consume(survivorId, purpose, wrongCodeFor(survivor)), null);
        }
        assert.ok(await AuthActionToken.consume(survivorId, purpose, survivor));

        const voidedId = await unverifiedAccount();
        const voided = await issue(voidedId);
        for (let attempt = 0; attempt < maxFailedCodeAttempts; attempt += 1) {
            assert.equal(await AuthActionToken.consume(voidedId, purpose, wrongCodeFor(voided)), null);
        }
        assert.equal(await AuthActionToken.consume(voidedId, purpose, voided), null);
        const slot = await getDb()!.collection('authActionTokens').findOne({ userId: voidedId, purpose });
        assert.equal(slot?.failedAttempts, maxFailedCodeAttempts);
        assert.ok(slot?.voidedAt);
        assert.equal(slot?.registration, undefined);

        // A newly requested code starts with a fresh attempt budget.
        const replacement = await issue(voidedId);
        assert.equal(await AuthActionToken.consume(voidedId, purpose, wrongCodeFor(replacement)), null);
        assert.ok(await AuthActionToken.consume(voidedId, purpose, replacement));
    });
}

test('concurrent wrong guesses cannot outlast the attempt cap', async () => {
    const userId = await unverifiedAccount();
    const code = await AuthActionToken.issue(userId, 'resetPassword', 15);
    const guesses = Array.from({ length: 12 }, (_, index) => String(100_000 + index)).filter(guess => guess !== code);
    const beginGuessing = startBarrier(guesses.length);
    const results = await Promise.all(guesses.map(async (guess) => {
        await beginGuessing();
        return AuthActionToken.consume(userId, 'resetPassword', guess);
    }));
    assert.equal(results.filter(Boolean).length, 0);
    assert.equal(await AuthActionToken.consume(userId, 'resetPassword', code), null);
    const slot = await getDb()!.collection('authActionTokens').findOne({ userId, purpose: 'resetPassword' });
    assert.equal(slot?.failedAttempts, maxFailedCodeAttempts, 'counting stops once the code is void');
});

test('codes stored before single-slot issuance are not accepted', async () => {
    const userId = await unverifiedAccount();
    const code = '123456';
    const now = new Date();
    await getDb()!.collection('authActionTokens').insertOne({
        _id: new ObjectId(),
        userId,
        purpose: 'resetPassword',
        codeHash: codeHash(userId, 'resetPassword', code),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60_000)
    });

    assert.equal(await AuthActionToken.consume(userId, 'resetPassword', code), null);
});
