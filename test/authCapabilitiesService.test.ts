import assert from 'node:assert/strict';
import test from 'node:test';
import { getAuthenticationCapabilities } from '../src/services/authCapabilitiesService';

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
        WEBAUTHN_RP_ID: 'auth.example.com',
        WEBAUTHN_ORIGIN: 'https://auth.example.com'
    });
    assert.equal(complete.emailRegistration, true);
    assert.equal(complete.passkey, true);
});

test('accepts comma-separated provider audiences only when one is non-empty', () => {
    const capabilities = getAuthenticationCapabilities({
        APPLE_CLIENT_IDS: ' , com.example.app ',
        GOOGLE_CLIENT_IDS: 'server-client-id'
    });
    assert.equal(capabilities.apple, true);
    assert.equal(capabilities.google, true);
});
