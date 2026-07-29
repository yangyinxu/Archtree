import assert from 'node:assert/strict';
import test from 'node:test';
import {
    accessTokenDurationSeconds,
    allowsLegacyAuthTokens,
    getJwtSecret,
    refreshSessionDurationMilliseconds
} from '../src/services/authSessionService';

const trackedKeys = [
    'NODE_ENV',
    'ACCESS_TOKEN_SECONDS',
    'ACCESS_TOKEN_MINUTES',
    'REFRESH_SESSION_DAYS',
    'SESSION_DAYS',
    'ALLOW_LEGACY_AUTH_TOKENS',
    'JWT_SECRET'
] as const;

/** Runs configuration assertions without leaking environment changes across tests. */
const withEnvironment = (values: Partial<Record<typeof trackedKeys[number], string>>, action: () => void) => {
    const previous = Object.fromEntries(trackedKeys.map(key => [key, process.env[key]]));
    try {
        for (const key of trackedKeys) {
            delete process.env[key];
        }
        Object.assign(process.env, values);
        action();
    } finally {
        for (const key of trackedKeys) {
            const value = previous[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
};

test('supports bounded short development access tokens', { concurrency: false }, () => {
    withEnvironment(
        { NODE_ENV: 'develop', ACCESS_TOKEN_SECONDS: '5' },
        () => assert.equal(accessTokenDurationSeconds(), 5)
    );
    withEnvironment(
        { NODE_ENV: 'develop', ACCESS_TOKEN_SECONDS: '9999' },
        () => assert.equal(accessTokenDurationSeconds(), 300)
    );
});

test('uses minute-based production access tokens and bounds refresh sessions', { concurrency: false }, () => {
    withEnvironment(
        { NODE_ENV: 'production', ACCESS_TOKEN_SECONDS: '5', ACCESS_TOKEN_MINUTES: '20' },
        () => assert.equal(accessTokenDurationSeconds(), 1_200)
    );
    withEnvironment(
        { REFRESH_SESSION_DAYS: '120' },
        () => assert.equal(refreshSessionDurationMilliseconds(), 90 * 24 * 60 * 60 * 1_000)
    );
});

test('legacy authentication must be explicitly enabled', { concurrency: false }, () => {
    withEnvironment({}, () => assert.equal(allowsLegacyAuthTokens(), false));
    withEnvironment(
        { ALLOW_LEGACY_AUTH_TOKENS: 'true' },
        () => assert.equal(allowsLegacyAuthTokens(), true)
    );
});

test('JWT operations fail closed without a signing secret', { concurrency: false }, () => {
    withEnvironment({}, () => assert.throws(() => getJwtSecret(), /not configured/i));
    withEnvironment(
        { JWT_SECRET: 'test-only-secret' },
        () => assert.equal(getJwtSecret(), 'test-only-secret')
    );
});
