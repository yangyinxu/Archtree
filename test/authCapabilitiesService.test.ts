import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getAuthenticationCapabilities,
    getBrowserAuthenticationCapabilities
} from '../src/services/authCapabilitiesService';

test('reports only password when optional authentication providers are absent', () => {
    assert.deepEqual(getAuthenticationCapabilities({}), {
        password: true,
        emailRegistration: false,
        apple: false,
        google: false,
        passkey: false
    });
});

test('requires complete email and HTTPS passkey configuration', () => {
    const partial = getAuthenticationCapabilities({
        AUTH_EMAIL_FROM: 'auth@example.com',
        WEBAUTHN_RP_ID: 'auth.example.com',
        WEBAUTHN_ORIGIN: 'http://auth.example.com'
    });
    assert.equal(partial.emailRegistration, false);
    assert.equal(partial.passkey, false);

    const complete = getAuthenticationCapabilities({
        AUTH_EMAIL_FROM: 'auth@example.com',
        AWS_REGION: 'us-east-1',
        AUTH_CODE_PEPPER: 'not-a-real-secret',
        AUTH_LINK_ORIGIN: 'https://listen.example.com',
        WEBAUTHN_RP_ID: 'auth.example.com',
        WEBAUTHN_ORIGIN: 'https://auth.example.com'
    });
    assert.equal(complete.emailRegistration, true);
    assert.equal(complete.passkey, true);
});

test('requires a code pepper before advertising email registration', () => {
    const capabilities = getAuthenticationCapabilities({
        AUTH_EMAIL_FROM: 'auth@example.com',
        AWS_REGION: 'us-east-1',
        AUTH_LINK_ORIGIN: 'https://listen.example.com'
    });
    assert.equal(capabilities.emailRegistration, false);
});

const emailDelivery = {
    AUTH_EMAIL_FROM: 'auth@example.com',
    AWS_REGION: 'us-east-1',
    AUTH_CODE_PEPPER: 'not-a-real-secret'
};

test('requires a valid AUTH_LINK_ORIGIN before advertising email registration', () => {
    for (const environment of [{}, { AUTH_LINK_ORIGIN: '' }, { AUTH_LINK_ORIGIN: 'not a url' }]) {
        assert.equal(getAuthenticationCapabilities({ ...emailDelivery, ...environment }).emailRegistration, false);
        assert.equal(getBrowserAuthenticationCapabilities({ ...emailDelivery, ...environment }).emailRegistration, false);
    }
    for (const origin of [
        'https://listen.example.com/finitude',
        'https://listen.example.com/?next=1',
        'https://listen.example.com/#token',
        'https://listen.example.com?',
        'https://user:secret@listen.example.com',
        'ftp://listen.example.com',
        'javascript:alert(1)'
    ]) {
        assert.equal(
            getAuthenticationCapabilities({ ...emailDelivery, AUTH_LINK_ORIGIN: origin }).emailRegistration,
            false,
            origin
        );
    }
    assert.equal(getAuthenticationCapabilities({
        ...emailDelivery, AUTH_LINK_ORIGIN: 'https://listen.example.com/'
    }).emailRegistration, true);
});

test('allows an http link origin only for loopback outside production', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
        assert.equal(getAuthenticationCapabilities({
            ...emailDelivery, AUTH_LINK_ORIGIN: origin, NODE_ENV: 'develop'
        }).emailRegistration, true, origin);
        assert.equal(getAuthenticationCapabilities({
            ...emailDelivery, AUTH_LINK_ORIGIN: origin, NODE_ENV: 'production'
        }).emailRegistration, false, `${origin} in production`);
    }
    assert.equal(getAuthenticationCapabilities({
        ...emailDelivery, AUTH_LINK_ORIGIN: 'http://listen.example.com', NODE_ENV: 'develop'
    }).emailRegistration, false);
});

test('accepts comma-separated provider audiences only when one is non-empty', () => {
    const capabilities = getAuthenticationCapabilities({
        APPLE_CLIENT_IDS: ' , com.example.app ',
        GOOGLE_CLIENT_IDS: 'server-client-id'
    });
    assert.equal(capabilities.apple, true);
    assert.equal(capabilities.google, true);
});

test('browser capabilities never inherit native-only provider configuration', () => {
    assert.deepEqual(getBrowserAuthenticationCapabilities({
        AUTH_EMAIL_FROM: 'auth@example.com',
        AWS_REGION: 'us-east-1',
        JWT_SECRET: 'test-pepper',
        AUTH_LINK_ORIGIN: 'https://listen.example.com',
        APPLE_CLIENT_IDS: 'com.example.native',
        GOOGLE_CLIENT_IDS: 'native-client-id',
        WEBAUTHN_RP_ID: 'auth.example.com',
        WEBAUTHN_ORIGIN: 'https://auth.example.com'
    }), {
        password: true,
        emailRegistration: true,
        apple: false,
        google: false,
        passkey: false
    });
});
