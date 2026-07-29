import assert from 'node:assert/strict';
import test from 'node:test';
import {
    verifyAppleIdentity,
    verifyGoogleIdentity
} from '../src/services/federatedIdentityService';

interface HTTPError extends Error {
    statusCode?: number;
}

/** Confirms malformed credentials fail before any remote identity-provider request. */
const rejectsWithStatus = async (
    operation: () => Promise<unknown>,
    statusCode: number
) => {
    await assert.rejects(operation, (error: HTTPError) => {
        assert.equal(error.statusCode, statusCode);
        return true;
    });
};

test('Apple identity verification rejects missing and oversized inputs locally', async () => {
    await rejectsWithStatus(() => verifyAppleIdentity('', 'nonce'), 401);
    await rejectsWithStatus(
        () => verifyAppleIdentity('token', 'n'.repeat(257)),
        401
    );
    await rejectsWithStatus(
        () => verifyAppleIdentity('t'.repeat(10_001), 'nonce'),
        401
    );
});

test('Google identity verification rejects missing and oversized inputs locally', async () => {
    await rejectsWithStatus(() => verifyGoogleIdentity('', 'nonce'), 401);
    await rejectsWithStatus(
        () => verifyGoogleIdentity('token', 'n'.repeat(257)),
        401
    );
    await rejectsWithStatus(
        () => verifyGoogleIdentity('t'.repeat(10_001), 'nonce'),
        401
    );
});

test('federated verification fails closed when provider audiences are absent', async () => {
    const appleAudiences = process.env.APPLE_CLIENT_IDS;
    const googleAudiences = process.env.GOOGLE_CLIENT_IDS;
    delete process.env.APPLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_IDS;
    try {
        await rejectsWithStatus(() => verifyAppleIdentity('token', 'nonce'), 503);
        await rejectsWithStatus(() => verifyGoogleIdentity('token', 'nonce'), 503);
    } finally {
        if (appleAudiences === undefined) delete process.env.APPLE_CLIENT_IDS;
        else process.env.APPLE_CLIENT_IDS = appleAudiences;
        if (googleAudiences === undefined) delete process.env.GOOGLE_CLIENT_IDS;
        else process.env.GOOGLE_CLIENT_IDS = googleAudiences;
    }
});
