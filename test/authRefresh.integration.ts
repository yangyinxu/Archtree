import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import { AuthSessionDocument } from '../src/models/authSession';
import {
    createSession,
    refreshSession,
    refreshTokenReplayGraceMilliseconds,
    SessionTokens
} from '../src/services/authSessionService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
const password = 'lorem ipsum dolor sit amet';

const closeServer = (value?: Server) => new Promise<void>((resolve, reject) => {
    if (!value) return resolve();
    value.close((error) => error ? reject(error) : resolve());
});

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const sessions = () => getDb()!.collection<AuthSessionDocument>('authSessions');

const storedSession = async (sessionId: string) => {
    const session = await sessions().findOne({ _id: new ObjectId(sessionId) });
    assert.ok(session);
    return session;
};

/** Inserts a verified, synthetic listener whose password can sign in through the API. */
const createListener = async (name: string) => {
    const user = {
        _id: new ObjectId(),
        email: `${name}@example.test`,
        password: await bcrypt.hash(password, 4),
        username: name,
        displayName: 'Lorem Ipsum',
        posts: [],
        role: 'user',
        emailVerified: true
    };
    await getDb()!.collection('users').insertOne(user);
    return user;
};

const postJson = (pathname: string, body: Record<string, unknown>) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

const refreshVia = (refreshToken: string) => postJson('/auth/refresh', { refreshToken });

const refreshedPair = async (refreshToken: string) => {
    const response = await refreshVia(refreshToken);
    assert.equal(response.status, 200);
    return await response.json() as SessionTokens;
};

beforeEach(() => {
    resetRateLimitWindowsForTests();
});

before(async () => {
    harness = await startMongoReplicaSet('archtree-auth-refresh-test');
    const app = createApp({ environment: 'test' });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    await closeServer(server);
    await harness?.stop();
});

test('a lost refresh response is recovered by replaying the previous token inside the grace window', async () => {
    const user = await createListener('lorem-lost-response');
    const initial = await createSession(user);

    // The server rotates, but the client never receives this pair.
    const lost = await refreshedPair(initial.refreshToken);
    const recovered = await refreshedPair(initial.refreshToken);

    assert.equal(recovered.sessionId, initial.sessionId, 'the replay rotates the same session');
    assert.notEqual(recovered.refreshToken, lost.refreshToken, 'the replay issues a fresh pair');
    assert.notEqual(recovered.refreshToken, initial.refreshToken);
    const me = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${recovered.accessToken}` }
    });
    assert.equal(me.status, 200);

    const stored = await storedSession(initial.sessionId);
    assert.equal(stored.refreshTokenHash, sha256(recovered.refreshToken), 'exactly the recovered token is current');
    assert.equal(stored.previousRefreshTokenHash, sha256(initial.refreshToken));
    const persisted = JSON.stringify(stored);
    for (const token of [initial.refreshToken, lost.refreshToken, recovered.refreshToken]) {
        assert.equal(persisted.includes(token), false, 'refresh tokens are persisted only as hashes');
    }

    assert.equal((await refreshVia(lost.refreshToken)).status, 401, 'the undelivered pair is superseded');
    const next = await refreshedPair(recovered.refreshToken);
    assert.equal(next.sessionId, initial.sessionId);
    assert.equal(
        (await refreshVia(initial.refreshToken)).status,
        401,
        'a normal rotation makes the replayed token older than the previous one'
    );
});

test('replaying the previous token after the grace window is rejected without changing the session', async () => {
    const user = await createListener('ipsum-after-window');
    const initial = await createSession(user);
    const delivered = await refreshedPair(initial.refreshToken);

    // Age the rotation instead of sleeping through the real window.
    await sessions().updateOne(
        { _id: new ObjectId(initial.sessionId) },
        { $set: { rotatedAt: new Date(Date.now() - refreshTokenReplayGraceMilliseconds - 1_000) } }
    );
    const before = await storedSession(initial.sessionId);

    const replay = await refreshVia(initial.refreshToken);
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { message: 'Authentication failed.' });

    const after = await storedSession(initial.sessionId);
    assert.equal(after.refreshTokenHash, before.refreshTokenHash, 'a rejected replay does not rotate');
    assert.equal(after.revokedAt, undefined, 'a rejected replay does not revoke the session');
    assert.equal((await refreshedPair(delivered.refreshToken)).sessionId, initial.sessionId);
});

test('tokens older than the immediately previous token are rejected inside the grace window', async () => {
    const user = await createListener('dolor-older-token');
    const initial = await createSession(user);
    const second = await refreshedPair(initial.refreshToken);
    const third = await refreshedPair(second.refreshToken);

    assert.equal((await refreshVia(initial.refreshToken)).status, 401);
    const stored = await storedSession(initial.sessionId);
    assert.equal(stored.refreshTokenHash, sha256(third.refreshToken), 'the rejected token leaves the current pair');
    assert.equal(stored.previousRefreshTokenHash, sha256(second.refreshToken));
    assert.equal((await refreshedPair(third.refreshToken)).sessionId, initial.sessionId);
});

test('a revoked session cannot be recovered through the previous token', async () => {
    const user = await createListener('sit-revoked');
    const initial = await createSession(user);
    const delivered = await refreshedPair(initial.refreshToken);

    const logout = await postJson('/auth/logout', { refreshToken: delivered.refreshToken });
    assert.equal(logout.status, 204);
    assert.equal((await refreshVia(initial.refreshToken)).status, 401);
});

test('concurrent previous and current tokens leave exactly one current refresh token', async () => {
    const user = await createListener('amet-concurrent');
    const initial = await createSession(user);
    const current = await refreshSession(initial.refreshToken);
    assert.ok(current);

    const attempts = await Promise.all([
        ...Array.from({ length: 4 }, () => refreshSession(initial.refreshToken)),
        ...Array.from({ length: 4 }, () => refreshSession(current.refreshToken))
    ]);
    const issued = attempts.filter((tokens): tokens is SessionTokens => tokens !== null);
    assert.ok(issued.length >= 1, 'at least one concurrent attempt rotates the session');

    const stored = await storedSession(initial.sessionId);
    assert.equal(stored.revokedAt, undefined);
    const currentPairs = issued.filter(tokens => sha256(tokens.refreshToken) === stored.refreshTokenHash);
    assert.equal(currentPairs.length, 1, 'exactly one issued pair remains current');
    assert.ok(
        [sha256(initial.refreshToken), sha256(current.refreshToken)].includes(stored.previousRefreshTokenHash ?? ''),
        'the previous slot names a token presented in the race'
    );
    for (const superseded of issued.filter(tokens => tokens !== currentPairs[0])) {
        assert.equal(await refreshSession(superseded.refreshToken), null);
    }
    assert.ok(await refreshSession(currentPairs[0].refreshToken));
});

test('refresh is admitted while the login bucket for the same address is exhausted', async () => {
    const user = await createListener('consectetur-isolated');
    const initial = await createSession(user);

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const rejected = await postJson('/auth/login', {
            identifier: `unknown-${attempt}@example.test`,
            password: 'not the password'
        });
        assert.notEqual(rejected.status, 429, `login attempt ${attempt + 1} stays inside the login bucket`);
    }
    const limitedLogin = await postJson('/auth/login', { identifier: user.email, password });
    assert.equal(limitedLogin.status, 429, 'the login limit itself is unchanged');

    const refreshed = await refreshVia(initial.refreshToken);
    assert.equal(refreshed.status, 200, 'refresh does not draw from the login bucket');
});

test('refresh traffic does not spend the login bucket', async () => {
    const user = await createListener('adipiscing-chain');
    let tokens = await createSession(user);
    for (let rotation = 0; rotation < 25; rotation += 1) {
        tokens = await refreshedPair(tokens.refreshToken);
    }

    const login = await postJson('/auth/login', { identifier: user.email, password });
    assert.equal(login.status, 200);
});

test('refresh limits each presented credential separately and falls back to the client address', async () => {
    const user = await createListener('elit-credential');
    const initial = await createSession(user);
    const unknownToken = crypto.randomBytes(48).toString('base64url');

    for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await refreshVia(unknownToken)).status, 401);
    }
    const limited = await refreshVia(unknownToken);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(
        (await refreshVia(crypto.randomBytes(48).toString('base64url'))).status,
        401,
        'another credential from the same address keeps its own budget'
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await postJson('/auth/refresh', {})).status, 401);
    }
    assert.equal((await postJson('/auth/refresh', {})).status, 429, 'requests without a token share the address bucket');
    assert.equal((await refreshVia(initial.refreshToken)).status, 200, 'a valid token is not limited by that bucket');
});
