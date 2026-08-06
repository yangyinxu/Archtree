import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import AuthActionToken, { AuthActionPurpose } from '../src/models/authActionToken';
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

const legacyHash = (userId: string, purpose: AuthActionPurpose, code: string) => crypto
    .createHmac('sha256', testPepper)
    .update(`${userId}:${purpose}:${code}`, 'utf8')
    .digest('hex');

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
    const userId = new ObjectId().toHexString();
    const requestCount = 16;
    const beginIssue = startBarrier(requestCount);
    const codes = await Promise.all(Array.from({ length: requestCount }, async () => {
        await beginIssue();
        return AuthActionToken.issue(userId, 'verifyEmail', 30);
    }));

    const stored = await getDb()!.collection('authActionTokens')
        .find({ userId, purpose: 'verifyEmail' })
        .toArray();
    assert.equal(stored.length, 1);
    assert.equal(typeof stored[0]._id, 'string');
    assert.equal(stored[0].consumedAt, undefined);

    const beginConsume = startBarrier(codes.length);
    const results = await Promise.all(codes.map(async (code) => {
        await beginConsume();
        return AuthActionToken.consume(userId, 'verifyEmail', code);
    }));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(
        await getDb()!.collection('authActionTokens').countDocuments({
            userId,
            purpose: 'verifyEmail',
            consumedAt: { $exists: false }
        }),
        0
    );
});

test('a delivered legacy code remains consumable before the first single-slot issue', async () => {
    const userId = new ObjectId().toHexString();
    const code = '123456';
    const now = new Date();
    await getDb()!.collection('authActionTokens').insertOne({
        _id: new ObjectId(),
        userId,
        purpose: 'resetPassword',
        codeHash: legacyHash(userId, 'resetPassword', code),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60_000)
    });

    assert.ok(await AuthActionToken.consume(userId, 'resetPassword', code));
    assert.equal(await AuthActionToken.consume(userId, 'resetPassword', code), null);
});

test('distinct legacy codes race through one migration claim', async () => {
    const userId = new ObjectId().toHexString();
    const codes = ['123456', '654321'];
    const now = new Date();
    await getDb()!.collection('authActionTokens').insertMany(codes.map((code) => ({
        _id: new ObjectId(),
        userId,
        purpose: 'resetPassword',
        codeHash: legacyHash(userId, 'resetPassword', code),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60_000)
    })));

    const beginConsume = startBarrier(codes.length);
    const results = await Promise.all(codes.map(async (code) => {
        await beginConsume();
        return AuthActionToken.consume(userId, 'resetPassword', code);
    }));

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(
        await getDb()!.collection('authActionTokens').countDocuments({
            userId,
            purpose: 'resetPassword',
            _id: { $type: 'string' }
        }),
        1
    );
    assert.equal(await AuthActionToken.consume(userId, 'resetPassword', codes[0]), null);
    assert.equal(await AuthActionToken.consume(userId, 'resetPassword', codes[1]), null);
});

test('issuing into the single slot invalidates an earlier legacy code', async () => {
    const userId = new ObjectId().toHexString();
    const legacyCode = '654321';
    const now = new Date();
    await getDb()!.collection('authActionTokens').insertOne({
        _id: new ObjectId(),
        userId,
        purpose: 'verifyEmail',
        codeHash: legacyHash(userId, 'verifyEmail', legacyCode),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30 * 60_000)
    });

    const currentCode = await AuthActionToken.issue(userId, 'verifyEmail', 30);

    assert.equal(await AuthActionToken.consume(userId, 'verifyEmail', legacyCode), null);
    assert.ok(await AuthActionToken.consume(userId, 'verifyEmail', currentCode));
});
