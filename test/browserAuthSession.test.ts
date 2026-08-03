import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSessionPayload, safeWebReturnTo } from '../src/controllers/authController';
import {
    browserMutationRejection,
    browserSessionCookieHeaders,
    clearedBrowserSessionCookieHeaders,
    cookieMutationRejection
} from '../src/services/authCookieService';
import { normalizeUserRole } from '../src/services/authRoleService';

const tokenPair = (accessToken: string, refreshToken: string) => ({
    accessToken,
    refreshToken,
    accessTokenExpiresIn: 900,
    refreshTokenExpiresAt: new Date(Date.now() + 60_000).toISOString()
});

test('browser identity projection never includes tokens or a session identifier', () => {
    const payload = browserSessionPayload({
        userId: 'user-123',
        email: 'listener@example.com',
        role: 'user',
        displayName: 'Listener',
        avatarRevision: 4,
        avatarAssetId: 'private-avatar',
        emailVerified: true,
        authenticationMethods: ['password', 'apple', 'passkey'],
        accessToken: 'must-not-leak',
        refreshToken: 'must-not-leak-either',
        sessionId: 'private-session-id'
    } as Parameters<typeof browserSessionPayload>[0] & Record<string, unknown>);

    assert.deepEqual(payload, {
        user: {
            id: 'user-123',
            email: 'listener@example.com',
            role: 'user',
            displayName: 'Listener',
            avatarRevision: 4,
            avatar: { revision: 4 },
            emailVerified: true,
            authenticationMethods: ['password', 'apple', 'passkey']
        }
    });
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /must-not-leak|private-session-id/);
    assert.equal('accessToken' in payload.user, false);
    assert.equal('refreshToken' in payload.user, false);
    assert.equal('sessionId' in payload.user, false);
});

test('roles fail closed unless the persisted value is exactly admin', () => {
    assert.equal(normalizeUserRole('admin'), 'admin');
    for (const role of ['user', 'creator', 'ADMIN', ' admin ', '', undefined, null, 1]) {
        assert.equal(normalizeUserRole(role), 'user');
        assert.equal(browserSessionPayload({
            userId: 'role-test',
            email: 'role-test@example.com',
            role
        }).user.role, 'user');
    }
    assert.equal(browserSessionPayload({
        userId: 'admin-test',
        email: 'admin-test@example.com',
        role: 'admin'
    }).user.role, 'admin');
});

test('rotated credentials replace both HttpOnly cookie values', { concurrency: false }, () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'develop';
    try {
        const before = browserSessionCookieHeaders(tokenPair('access-old', 'refresh-old'));
        const after = browserSessionCookieHeaders(tokenPair('access-new', 'refresh-new'));

        assert.equal(before.length, 2);
        assert.equal(after.length, 2);
        assert.match(after[0], /^session_token=access-new;/);
        assert.match(after[1], /^refresh_token=refresh-new;/);
        assert.doesNotMatch(after.join('\n'), /access-old|refresh-old/);
        for (const header of after) {
            assert.match(header, /; HttpOnly;/);
            assert.match(header, /; Max-Age=\d+/);
        }
        assert.match(after[0], /SameSite=Lax/);
        assert.match(after[1], /SameSite=Strict/);
    } finally {
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
    }
});

test('logout headers expire both browser credentials', () => {
    const headers = clearedBrowserSessionCookieHeaders();
    assert.equal(headers.length, 2);
    assert.match(headers[0], /^session_token=;/);
    assert.match(headers[1], /^refresh_token=;/);
    for (const header of headers) {
        assert.match(header, /HttpOnly/);
        assert.match(header, /Max-Age=0/);
    }
});

test('production browser credentials are host-only Secure HttpOnly cookies', { concurrency: false }, () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
        const active = browserSessionCookieHeaders(tokenPair('access', 'refresh'));
        const cleared = clearedBrowserSessionCookieHeaders();
        for (const header of [...active, ...cleared]) {
            assert.match(header, /; Path=\//);
            assert.match(header, /; HttpOnly;/);
            assert.match(header, /; Secure$/);
            assert.doesNotMatch(header, /; Domain=/i, 'omitting Domain keeps the cookie host-only');
        }
        assert.match(active[0], /SameSite=Lax/);
        assert.match(active[1], /SameSite=Strict/);
    } finally {
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
    }
});

test('browser mutations reject cross-site and non-JSON requests', () => {
    const sameOrigin = {
        contentType: 'application/json; charset=utf-8',
        origin: 'https://music.example.com',
        requestOrigin: 'https://music.example.com'
    };
    assert.equal(browserMutationRejection(sameOrigin), null);
    assert.deepEqual(
        browserMutationRejection({ ...sameOrigin, origin: 'https://attacker.example' }),
        { status: 403, message: 'Cross-site browser authentication is not allowed.' }
    );
    assert.equal(
        browserMutationRejection({
            ...sameOrigin,
            allowedOrigins: ['https://listener-preview.example.com']
        }),
        null,
        'an additional deployment allowlist must not disable the request origin'
    );
    assert.equal(
        browserMutationRejection({
            ...sameOrigin,
            origin: 'https://listener-preview.example.com',
            allowedOrigins: ['https://listener-preview.example.com']
        }),
        null
    );
    assert.deepEqual(
        browserMutationRejection({ ...sameOrigin, contentType: 'application/x-www-form-urlencoded' }),
        { status: 415, message: 'Browser authentication requires JSON.' }
    );
    assert.deepEqual(
        browserMutationRejection({
            contentType: 'application/json',
            requestOrigin: 'https://music.example.com',
            secFetchSite: 'cross-site'
        }),
        { status: 403, message: 'Cross-site browser authentication is not allowed.' }
    );
    assert.equal(
        browserMutationRejection({
            contentType: 'application/json',
            requestOrigin: 'https://music.example.com'
        }),
        null,
        'non-browser JSON clients may omit Origin when no Fetch Metadata reports cross-site use'
    );
});

test('cookie-authenticated writes require same-origin browser evidence', () => {
    const requestOrigin = 'https://music.example.com';
    assert.equal(cookieMutationRejection({
        requestOrigin,
        origin: requestOrigin
    }), null);
    assert.equal(cookieMutationRejection({
        requestOrigin,
        secFetchSite: 'same-origin'
    }), null);
    assert.deepEqual(
        cookieMutationRejection({ requestOrigin }),
        { status: 403, message: 'Cross-site browser authentication is not allowed.' }
    );
    assert.deepEqual(
        cookieMutationRejection({ requestOrigin, secFetchSite: 'same-site' }),
        { status: 403, message: 'Cross-site browser authentication is not allowed.' }
    );
});

test('legacy browser login redirects only to known local pages', () => {
    assert.equal(safeWebReturnTo('/listen/library?sort=recent#saved'), '/listen/library?sort=recent#saved');
    assert.equal(safeWebReturnTo('/content/manage/audio-tracks'), '/content/manage/audio-tracks');
    assert.equal(safeWebReturnTo('https://attacker.example'), '/');
    assert.equal(safeWebReturnTo('//attacker.example'), '/');
    assert.equal(safeWebReturnTo('/\\attacker.example'), '/');
    assert.equal(safeWebReturnTo('/auth/browser/session'), '/');
});
