import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
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
        transitionCapability?: boolean;
    } = {}
) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Origin: options.origin ?? baseUrl,
        'Sec-Fetch-Site': options.origin && options.origin !== baseUrl ? 'cross-site' : 'same-origin',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.viewerId ? { 'X-Finitude-Account-Viewer': options.viewerId } : {}),
        ...((options.transitionCapability ?? /^\/auth\/browser\/(?:login|refresh|logout)$/.test(pathname))
            ? { 'X-Finitude-Session-Transition': 'web-locks-v1' }
            : {})
    },
    body: JSON.stringify(options.body ?? {})
});

const accountBoundRequest = (
    pathname: string,
    options: {
        cookie?: string;
        method?: string;
        viewerId?: string;
        body?: Record<string, unknown>;
        authorization?: string;
    } = {}
) => {
    const method = options.method ?? 'GET';
    const hasBody = !['GET', 'HEAD'].includes(method);
    return fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin',
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}),
            ...(options.viewerId ? { 'X-Finitude-Account-Viewer': options.viewerId } : {}),
            ...(options.authorization ? { Authorization: options.authorization } : {})
        },
        ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {})
    });
};

beforeEach(() => {
    resetRateLimitWindowsForTests();
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
    await getDb()!.collection('users').insertOne({
        _id: new ObjectId(),
        email: 'second-listener@example.com',
        password,
        username: 'second-listener',
        displayName: 'Second Listener',
        posts: [],
        role: 'user',
        emailVerified: true,
        avatarRevision: 0
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

test('credential-setting browser endpoints require the Web Lock capability', async () => {
    const headerlessLogin = await browserMutation('/auth/browser/login', {
        transitionCapability: false,
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(headerlessLogin.status, 409);
    assert.equal((await headerlessLogin.json()).code, 'browser_session_transition_required');
    assert.equal(setCookieHeaders(headerlessLogin).length, 0);

    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const jar = cookieJar(setCookieHeaders(login));
    const headerlessRefresh = await browserMutation('/auth/browser/refresh', {
        cookie: jar,
        transitionCapability: false
    });
    assert.equal(headerlessRefresh.status, 409);
    assert.equal((await headerlessRefresh.json()).code, 'browser_session_transition_required');
    assert.equal(setCookieHeaders(headerlessRefresh).length, 0);
});

test('legacy HTML login redirects to the coordinated SPA without setting credentials', async () => {
    const loginPage = await fetch(
        `${baseUrl}/auth/login-web?returnTo=${encodeURIComponent('/content/manage')}`,
        { redirect: 'manual' }
    );
    assert.equal(loginPage.status, 303);
    assert.equal(loginPage.headers.get('location'), '/finitude/login?returnTo=%2Fcontent%2Fmanage');
    assert.equal(setCookieHeaders(loginPage).length, 0);

    const legacyPost = await fetch(`${baseUrl}/auth/login-web`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({
            identifier: 'listener@example.com',
            password: 'correct horse battery staple',
            returnTo: '/content/manage'
        })
    });
    assert.equal(legacyPost.status, 303);
    assert.equal(legacyPost.headers.get('location'), '/finitude/login?returnTo=%2Fcontent%2Fmanage');
    assert.equal(setCookieHeaders(legacyPost).length, 0);
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
    assert.equal(refresh.headers.get('x-finitude-account-viewer'), loginBody.user.id);
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

    const replay = await browserMutation('/auth/browser/refresh', {
        cookie: loginJar,
        viewerId: loginBody.user.id
    });
    assert.equal(replay.status, 401, 'a rotated refresh cookie can be consumed only once');
    assert.equal(setCookieHeaders(replay).length, 0, 'a losing refresh must not clear a winning response');

    const logout = await browserMutation('/auth/browser/logout', {
        cookie: rotatedJar,
        viewerId: loginBody.user.id
    });
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

test('browser refresh rejects a revoked access identity mixed with another account refresh', async () => {
    const first = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(first.status, 200);
    const firstViewer = (await first.clone().json()).user.id as string;
    const firstJar = cookieJar(setCookieHeaders(first));

    const revokeFirst = await browserMutation('/auth/browser/logout', {
        cookie: firstJar,
        viewerId: firstViewer
    });
    assert.equal(revokeFirst.status, 204);

    const second = await browserMutation('/auth/browser/login', {
        body: { identifier: 'second-listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(second.status, 200);
    const secondViewer = (await second.clone().json()).user.id as string;
    const secondJar = cookieJar(setCookieHeaders(second));

    const staleViewer = await browserMutation('/auth/browser/refresh', {
        cookie: secondJar,
        viewerId: firstViewer
    });
    assert.equal(staleViewer.status, 409);
    assert.equal((await staleViewer.json()).code, 'browser_session_identity_conflict');
    assert.equal(setCookieHeaders(staleViewer).length, 0);

    const mixedJar = [
        `session_token=${cookieValue(firstJar, 'session_token')}`,
        `refresh_token=${cookieValue(secondJar, 'refresh_token')}`
    ].join('; ');

    const conflict = await browserMutation('/auth/browser/refresh', {
        cookie: mixedJar,
        viewerId: firstViewer
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
        code: 'browser_session_identity_conflict',
        message: 'The browser session contains conflicting account credentials.'
    });
    assert.equal(setCookieHeaders(conflict).length, 0);

    const validSecondRefresh = await browserMutation('/auth/browser/refresh', {
        cookie: secondJar,
        viewerId: secondViewer
    });
    assert.equal(validSecondRefresh.status, 200, 'the rejected mixed request must not rotate the refresh cookie');
    assert.equal(validSecondRefresh.headers.get('x-finitude-account-viewer'), secondViewer);
    assert.equal((await validSecondRefresh.json()).user.id, secondViewer);
});

test('failed previous-session revocation preserves the existing browser cookies', { concurrency: false }, async () => {
    const first = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(first.status, 200);
    const firstJar = cookieJar(setCookieHeaders(first));
    const firstClaims = jwt.decode(cookieValue(firstJar, 'session_token')) as {
        sessionId?: string;
    } | null;
    assert.ok(firstClaims?.sessionId);

    const originalRevokeById = AuthSession.revokeById;
    const originalRevokeByRefreshTokenHash = AuthSession.revokeByRefreshTokenHash;
    AuthSession.revokeById = async (userId, sessionId) => {
        if (sessionId === firstClaims.sessionId) throw new Error('previous session database unavailable');
        return originalRevokeById(userId, sessionId);
    };
    AuthSession.revokeByRefreshTokenHash = async () => {
        throw new Error('previous refresh database unavailable');
    };
    try {
        const replacement = await browserMutation('/auth/browser/login', {
            cookie: firstJar,
            body: {
                identifier: 'second-listener@example.com',
                password: 'correct horse battery staple'
            }
        });
        assert.equal(replacement.status, 500);
        assert.equal(setCookieHeaders(replacement).length, 0);
    } finally {
        AuthSession.revokeById = originalRevokeById;
        AuthSession.revokeByRefreshTokenHash = originalRevokeByRefreshTokenHash;
    }

    const preserved = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: firstJar }
    });
    assert.equal(preserved.status, 200);
});

test('logout revokes the stable session even after its refresh token rotated', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const viewerId = (await login.clone().json()).user.id;
    const staleJar = cookieJar(setCookieHeaders(login));

    const refresh = await browserMutation('/auth/browser/refresh', { cookie: staleJar, viewerId });
    assert.equal(refresh.status, 200);
    const rotatedJar = cookieJar(setCookieHeaders(refresh));

    const staleLogout = await browserMutation('/auth/browser/logout', {
        cookie: staleJar,
        viewerId
    });
    assert.equal(staleLogout.status, 204);

    const refreshAfterLogout = await browserMutation('/auth/browser/refresh', {
        cookie: rotatedJar,
        viewerId
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

    const revokedRefresh = await browserMutation('/auth/browser/refresh', {
        cookie: refreshOnlyJar,
        viewerId
    });
    assert.equal(revokedRefresh.status, 401);
});

test('headerless logout is revoke-only and cannot return a delayed cookie clear', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    const viewerId = (await login.clone().json()).user.id;
    const jar = cookieJar(setCookieHeaders(login));

    const logout = await browserMutation('/auth/browser/logout', {
        cookie: jar,
        viewerId,
        transitionCapability: false
    });
    assert.equal(logout.status, 204);
    assert.equal(logout.headers.get('x-finitude-account-viewer'), viewerId);
    assert.equal(setCookieHeaders(logout).length, 0);
    assert.equal((await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: jar }
    })).status, 401);
});

test('mixed account cookies fail closed and a Web-Locked recovery revokes both', async () => {
    const first = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    const firstBody = await first.clone().json();
    const firstJar = cookieJar(setCookieHeaders(first));
    const second = await browserMutation('/auth/browser/login', {
        body: { identifier: 'second-listener@example.com', password: 'correct horse battery staple' }
    });
    const secondJar = cookieJar(setCookieHeaders(second));
    const mixedJar = [
        `session_token=${cookieValue(firstJar, 'session_token')}`,
        `refresh_token=${cookieValue(secondJar, 'refresh_token')}`
    ].join('; ');

    const probe = await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: mixedJar }
    });
    assert.equal(probe.status, 409);
    assert.equal((await probe.json()).code, 'browser_session_identity_conflict');
    assert.equal(setCookieHeaders(probe).length, 0);

    const headerless = await browserMutation('/auth/browser/logout', {
        cookie: mixedJar,
        viewerId: firstBody.user.id,
        transitionCapability: false
    });
    assert.equal(headerless.status, 409);
    assert.equal((await headerless.json()).code, 'browser_session_identity_conflict');
    assert.equal(setCookieHeaders(headerless).length, 0);

    const recovered = await browserMutation('/auth/browser/logout', {
        cookie: mixedJar
    });
    assert.equal(recovered.status, 204);
    assert.equal(setCookieHeaders(recovered).length, 2);
    assert.equal((await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: firstJar }
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/auth/browser/session`, {
        headers: { Cookie: secondJar }
    })).status, 401);
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
        browserMutation('/auth/browser/refresh', { cookie: refreshOnlyJar, viewerId }),
        browserMutation('/auth/browser/logout', { cookie: refreshOnlyJar, viewerId })
    ]);
    assert.equal(logout.status, 204);
    assert.ok([200, 401].includes(refresh.status));

    if (refresh.status === 200) {
        const rotatedJar = cookieJar(setCookieHeaders(refresh));
        const refreshAfterLogout = await browserMutation('/auth/browser/refresh', {
            cookie: rotatedJar,
            viewerId
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

test('cookie account surfaces reject a stale tab while matching and Bearer viewers remain compatible', async () => {
    const login = await browserMutation('/auth/browser/login', {
        body: { identifier: 'listener@example.com', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    const viewerId = (await login.clone().json()).user.id as string;
    const jar = cookieJar(setCookieHeaders(login));
    const bearer = `Bearer ${cookieValue(jar, 'session_token')}`;
    const staleViewerId = new ObjectId().toHexString();
    const targetId = new ObjectId().toHexString();

    const staleRequests = [
        ['/api/listener/v1/home', 'GET'],
        ['/api/listener/v1/library', 'GET'],
        ['/content/me/library', 'GET'],
        ['/content/me/saves/status', 'POST'],
        [`/content/me/saves/audioTrack/${targetId}`, 'PUT'],
        ['/content/me/recently-played', 'POST'],
        ['/auth/me', 'GET'],
        ['/auth/avatar', 'GET'],
        ['/auth/sessions', 'GET'],
        ['/auth/sessions/missing-session', 'DELETE'],
        ['/auth/password/change', 'POST'],
        ['/auth/identities/apple', 'DELETE'],
        ['/auth/passkeys/register/options', 'POST'],
        ['/auth/passkeys/register/verify', 'POST'],
        ['/auth/logout-all', 'POST'],
        ['/auth/activity/listening-history', 'DELETE'],
        ['/auth/account', 'DELETE'],
        ['/content/pages/library/expanded', 'GET']
    ] as const;
    for (const [pathname, method] of staleRequests) {
        const response = await accountBoundRequest(pathname, {
            cookie: jar,
            method,
            viewerId: staleViewerId,
            body: pathname.endsWith('/saves/status')
                ? { items: [] }
                : pathname.endsWith('/recently-played')
                    ? { contentType: 'audioTrack', contentId: targetId }
                    : {}
        });
        assert.equal(response.status, 409, `${method} ${pathname}`);
        assert.deepEqual(await response.json(), {
            code: 'account_viewer_mismatch',
            message: 'The active account changed. Refresh the account before trying again.'
        });
    }

    assert.equal(await getDb()!.collection('userSaves').countDocuments({ userId: viewerId }), 0);

    const missingViewer = await accountBoundRequest('/api/listener/v1/library', { cookie: jar });
    assert.equal(missingViewer.status, 409);
    assert.equal((await missingViewer.json()).code, 'account_viewer_mismatch');

    for (const pathname of ['/auth/me', '/auth/sessions', '/api/listener/v1/library', '/content/me/library']) {
        const response = await accountBoundRequest(pathname, { cookie: jar, viewerId });
        assert.equal(response.status, 200, pathname);
        assert.equal(response.headers.get('x-finitude-account-viewer'), viewerId);
        assert.match(response.headers.get('cache-control') ?? '', /(?:^|,\s*)no-store(?:,|$)/);
    }

    for (const pathname of ['/auth/me', '/auth/sessions', '/api/listener/v1/library']) {
        const response = await accountBoundRequest(pathname, { authorization: bearer });
        assert.equal(response.status, 200, `Bearer ${pathname}`);
    }

    const claimedAnonymous = await accountBoundRequest('/api/listener/v1/home', {
        viewerId: staleViewerId
    });
    assert.equal(claimedAnonymous.status, 409);
    assert.equal((await claimedAnonymous.json()).code, 'account_viewer_mismatch');
});

test('persisted roles override stale token claims and unknown values fail closed', async () => {
    const userId = new ObjectId();
    const email = 'role-authority@example.com';
    const password = 'role authority integration password';
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email,
        password: await bcrypt.hash(password, 4),
        username: 'role-authority',
        displayName: 'Role Authority',
        posts: [],
        role: 'creator',
        emailVerified: true,
        avatarRevision: 0
    });

    const legacyRoleLogin = await browserMutation('/auth/browser/login', {
        body: { identifier: email, password }
    });
    assert.equal(legacyRoleLogin.status, 200);
    assert.equal((await legacyRoleLogin.clone().json()).user.role, 'user');
    const legacyRoleJar = cookieJar(setCookieHeaders(legacyRoleLogin));
    const legacyRoleClaims = jwt.decode(cookieValue(legacyRoleJar, 'session_token')) as {
        role?: string;
    } | null;
    assert.equal(legacyRoleClaims?.role, 'user');

    const deniedAsLegacyRole = await fetch(`${baseUrl}/content/manage/audio-tracks`, {
        headers: { Cookie: legacyRoleJar },
        redirect: 'manual'
    });
    assert.equal(deniedAsLegacyRole.status, 403);

    await getDb()!.collection('users').updateOne(
        { _id: userId },
        { $set: { role: 'admin' } }
    );
    const grantedWithStaleUserClaim = await fetch(`${baseUrl}/content/manage/audio-tracks`, {
        headers: { Cookie: legacyRoleJar },
        redirect: 'manual'
    });
    assert.equal(grantedWithStaleUserClaim.status, 200);

    const adminLogin = await browserMutation('/auth/browser/login', {
        body: { identifier: email, password }
    });
    assert.equal(adminLogin.status, 200);
    assert.equal((await adminLogin.clone().json()).user.role, 'admin');
    const adminJar = cookieJar(setCookieHeaders(adminLogin));
    const adminClaims = jwt.decode(cookieValue(adminJar, 'session_token')) as {
        role?: string;
    } | null;
    assert.equal(adminClaims?.role, 'admin');

    await getDb()!.collection('users').updateOne(
        { _id: userId },
        { $set: { role: 'creator' } }
    );
    const deniedWithStaleAdminClaim = await fetch(`${baseUrl}/content/manage/audio-tracks`, {
        headers: { Cookie: adminJar },
        redirect: 'manual'
    });
    assert.equal(deniedWithStaleAdminClaim.status, 403);
});
