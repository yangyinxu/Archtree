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

/** Inserts a verified account directly so only the token model is under test. */
const account = async () => {
    const userId = new ObjectId().toHexString();
    await getDb()!.collection('users').insertOne({
        _id: new ObjectId(userId), email: `${userId}@example.test`, username: userId, emailVerified: true
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
    const userId = await account();
    const requestCount = 16;
    const beginIssue = startBarrier(requestCount);
    const codes = await Promise.all(Array.from({ length: requestCount }, async () => {
        await beginIssue();
        return AuthActionToken.issue(userId, 'resetPassword', 15);
    }));

    const stored = await getDb()!.collection('authActionTokens')
        .find({ userId, purpose: 'resetPassword' })
        .toArray();
    assert.equal(stored.length, 1);
    assert.equal(typeof stored[0]._id, 'string');
    assert.equal(stored[0].consumedAt, undefined);
    assert.equal(stored[0].registration, undefined, 'reset slots never carry registration credentials');

    // Only the last write is current. Find it by hash instead of submitting the
    // stale codes, whose wrong attempts would void it.
    const current = codes.filter(code => codeHash(userId, 'resetPassword', code) === stored[0].codeHash);
    assert.equal(new Set(current).size, 1);
    const beginConsume = startBarrier(requestCount);
    const results = await Promise.all(Array.from({ length: requestCount }, async () => {
        await beginConsume();
        return AuthActionToken.consume(userId, 'resetPassword', current[0]);
    }));
    assert.equal(results.filter(Boolean).length, 1);
    const consumed = await getDb()!.collection('authActionTokens').findOne({ userId, purpose: 'resetPassword' });
    assert.ok(consumed?.consumedAt);
});

test('a reset code survives four wrong attempts and the fifth voids it', async () => {
    const survivorId = await account();
    const survivor = await AuthActionToken.issue(survivorId, 'resetPassword', 15);
    for (let attempt = 1; attempt < maxFailedCodeAttempts; attempt += 1) {
        assert.equal(await AuthActionToken.consume(survivorId, 'resetPassword', wrongCodeFor(survivor)), null);
    }
    assert.ok(await AuthActionToken.consume(survivorId, 'resetPassword', survivor));

    const voidedId = await account();
    const voided = await AuthActionToken.issue(voidedId, 'resetPassword', 15);
    for (let attempt = 0; attempt < maxFailedCodeAttempts; attempt += 1) {
        assert.equal(await AuthActionToken.consume(voidedId, 'resetPassword', wrongCodeFor(voided)), null);
    }
    assert.equal(await AuthActionToken.consume(voidedId, 'resetPassword', voided), null);
    const slot = await getDb()!.collection('authActionTokens').findOne({ userId: voidedId, purpose: 'resetPassword' });
    assert.equal(slot?.failedAttempts, maxFailedCodeAttempts);
    assert.ok(slot?.voidedAt);

    // A newly requested code starts with a fresh attempt budget.
    const replacement = await AuthActionToken.issue(voidedId, 'resetPassword', 15);
    assert.equal(await AuthActionToken.consume(voidedId, 'resetPassword', wrongCodeFor(replacement)), null);
    assert.ok(await AuthActionToken.consume(voidedId, 'resetPassword', replacement));
});

test('concurrent wrong guesses cannot outlast the attempt cap', async () => {
    const userId = await account();
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
    const userId = await account();
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
