import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;

const closeServer = (value?: Server) => new Promise<void>((resolve, reject) => {
    if (!value) return resolve();
    value.close((error) => error ? reject(error) : resolve());
});

const setCookieHeaders = (response: Response) => {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    return headers.getSetCookie?.()
        ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
};

const cookieJar = (headers: string[]) => headers
    .map((header) => header.slice(0, header.indexOf(';')))
    .join('; ');

const cookieValue = (jar: string, name: string) => jar
    .split('; ')
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';

const browserMutation = (
    pathname: string,
    options: {
        body?: Record<string, unknown>;
        cookie?: string;
        origin?: string;
        viewerId?: string;
    } = {}
) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Origin: options.origin ?? baseUrl,
        'Sec-Fetch-Site': options.origin && options.origin !== baseUrl ? 'cross-site' : 'same-origin',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.viewerId ? { 'X-Finitude-Account-Viewer': options.viewerId } : {})
    },
    body: JSON.stringify(options.body ?? {})
});

before(async () => {
    harness = await startMongoReplicaSet('archtree-browser-auth-test');
    const password = await bcrypt.hash('correct horse battery staple', 4);
    const userId = new ObjectId();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'listener@example.com',
        password,
        username: 'listener',
        displayName: 'Test Listener',
        posts: [],
        role: 'user',
        emailVerified: true,
        avatarRevision: 0
    });
    await getDb()!.collection('authIdentities').insertOne({
        _id: new ObjectId(),
        userId: userId.toString(),
        provider: 'apple',
        providerSubject: 'browser-session-apple',
        createdAt: new Date(),
        updatedAt: new Date()
    });
    await getDb()!.collection('passkeys').insertOne({
        credentialId: 'browser-session-passkey',
        userId: userId.toString(),
        publicKey: 'public-key',
        counter: 0,
        transports: [],
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: new Date(),
        updatedAt: new Date()
    });

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

test('browser login, one-time refresh, session read, and logout keep tokens out of JSON', async () => {
    const crossSite = await browserMutation('/auth/browser/login', {
        origin: 'https://attacker.example',
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(crossSite.status, 403);

    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const loginText = await login.text();
    const loginBody = JSON.parse(loginText);
    assert.equal(loginBody.user.email, 'listener@example.com');
    assert.equal(loginBody.user.displayName, 'Test Listener');
    assert.deepEqual(loginBody.user.authenticationMethods, ['password', 'apple', 'passkey']);
    assert.equal('accessToken' in loginBody, false);
    assert.equal('refreshToken' in loginBody, false);
    assert.equal('sessionId' in loginBody, false);

    const loginCookieHeaders = setCookieHeaders(login);
    assert.equal(loginCookieHeaders.length, 2);
    assert.ok(loginCookieHeaders.every((header) => header.includes('HttpOnly')));
    const loginJar = cookieJar(loginCookieHeaders);
    const initialAccess = cookieValue(loginJar, 'session_token');
    const initialRefresh = cookieValue(loginJar, 'refresh_token');
    assert.ok(initialAccess);
    assert.ok(initialRefresh);
    assert.doesNotMatch(loginText, new RegExp(`${initialAccess}|${initialRefresh}`));

    const bearerOnly = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Authorization: `Bearer ${initialAccess}` }
    });
    assert.equal(bearerOnly.status, 401, 'the browser session endpoint accepts its cookie only');
    assert.equal(bearerOnly.headers.get('cache-control'), 'no-store');
    assert.equal(bearerOnly.headers.get('pragma'), 'no-cache');

    const session = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: loginJar }
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.id, loginBody.user.id);

    const staleViewerLogout = await browserMutation('/auth/browser/logout', {
        cookie: loginJar,
        viewerId: 'another-listener'
    });
    assert.equal(staleViewerLogout.status, 409);
    assert.equal(setCookieHeaders(staleViewerLogout).length, 0);
    const sessionAfterStaleViewer = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: loginJar }
    });
    assert.equal(sessionAfterStaleViewer.status, 200);

    const crossSiteCookieMutation = await browserMutation('/auth/logout-all', {
        cookie: loginJar,
        origin: 'https://attacker.example'
    });
    assert.equal(crossSiteCookieMutation.status, 403);

    const refresh = await browserMutation('/auth/browser/refresh', { cookie: loginJar });
    assert.equal(refresh.status, 200);
    const refreshText = await refresh.text();
    assert.equal(JSON.parse(refreshText).user.id, loginBody.user.id);
    const rotatedCookieHeaders = setCookieHeaders(refresh);
    assert.equal(rotatedCookieHeaders.length, 2);
    const rotatedJar = cookieJar(rotatedCookieHeaders);
    const rotatedAccess = cookieValue(rotatedJar, 'session_token');
    const rotatedRefresh = cookieValue(rotatedJar, 'refresh_token');
    assert.ok(rotatedAccess, 'rotation resets the short-lived access cookie');
    assert.notEqual(rotatedRefresh, initialRefresh);
    assert.doesNotMatch(refreshText, new RegExp(`${rotatedAccess}|${rotatedRefresh}`));

    const replay = await browserMutation('/auth/browser/refresh', { cookie: loginJar });
    assert.equal(replay.status, 401, 'a rotated refresh cookie can be consumed only once');
    assert.equal(setCookieHeaders(replay).length, 0, 'a losing refresh must not clear a winning response');

    const logout = await browserMutation('/auth/browser/logout', { cookie: rotatedJar });
    assert.equal(logout.status, 204);
    assert.equal(await logout.text(), '');
    const cleared = setCookieHeaders(logout);
    assert.equal(cleared.length, 2);
    assert.ok(cleared.every((header) => header.includes('Max-Age=0')));

    const revokedSession = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: rotatedJar }
    });
    assert.equal(revokedSession.status, 401);
});

test('logout revokes the stable session even after its refresh token rotated', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const staleJar = cookieJar(setCookieHeaders(login));

    const refresh = await browserMutation('/auth/browser/refresh', { cookie: staleJar });
    assert.equal(refresh.status, 200);
    const rotatedJar = cookieJar(setCookieHeaders(refresh));

    const staleLogout = await browserMutation('/auth/browser/logout', { cookie: staleJar });
    assert.equal(staleLogout.status, 204);

    const refreshAfterLogout = await browserMutation('/auth/browser/refresh', {
        cookie: rotatedJar
    });
    assert.equal(refreshAfterLogout.status, 401);
    const sessionAfterLogout = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: rotatedJar }
    });
    assert.equal(sessionAfterLogout.status, 401);
});

test('refresh-only logout remains bound to the account shown by the page', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const viewerId = (await login.json()).user.id;
    const jar = cookieJar(setCookieHeaders(login));
    const refreshOnlyJar = `refresh_token=${cookieValue(jar, 'refresh_token')}`;

    const staleViewerLogout = await browserMutation('/auth/browser/logout', {
        cookie: refreshOnlyJar,
        viewerId: 'another-listener'
    });
    assert.equal(staleViewerLogout.status, 409);
    assert.equal(setCookieHeaders(staleViewerLogout).length, 0);

    const matchingLogout = await browserMutation('/auth/browser/logout', {
        cookie: refreshOnlyJar,
        viewerId
    });
    assert.equal(matchingLogout.status, 204);
    assert.equal(setCookieHeaders(matchingLogout).length, 2);

    const revokedRefresh = await browserMutation('/auth/browser/refresh', { cookie: refreshOnlyJar });
    assert.equal(revokedRefresh.status, 401);
});

test('refresh-only logout revokes a session even when refresh rotates concurrently', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const viewerId = (await login.json()).user.id;
    const jar = cookieJar(setCookieHeaders(login));
    const refreshOnlyJar = `refresh_token=${cookieValue(jar, 'refresh_token')}`;

    const [refresh, logout] = await Promise.all([
        browserMutation('/auth/browser/refresh', { cookie: refreshOnlyJar }),
        browserMutation('/auth/browser/logout', { cookie: refreshOnlyJar, viewerId })
    ]);
    assert.equal(logout.status, 204);
    assert.ok([200, 401].includes(refresh.status));

    if (refresh.status === 200) {
        const rotatedJar = cookieJar(setCookieHeaders(refresh));
        const refreshAfterLogout = await browserMutation('/auth/browser/refresh', {
            cookie: rotatedJar
        });
        assert.equal(refreshAfterLogout.status, 401);
        const sessionAfterLogout = await fetch(`${baseUrl}/auth/browser/session`, {
            headers: { Cookie: rotatedJar }
        });
        assert.equal(sessionAfterLogout.status, 401);
    }
});

test('signed-out refresh and logout probes cannot exhaust the login limiter', async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
        const refresh = await browserMutation('/auth/browser/refresh');
        assert.equal(refresh.status, 401);
        const logout = await browserMutation('/auth/browser/logout');
        assert.equal(logout.status, 204);
    }

    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
});
