import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthProvider } from '../models/authIdentity';

export interface VerifiedFederatedIdentity {
    provider: AuthProvider;
    subject: string;
    email: string;
}

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleClient = new OAuth2Client();

const configuredAudiences = (name: string) => {
    const audiences = String(process.env[name] ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    if (audiences.length === 0) {
        const error = new Error(`${name} is not configured.`) as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
    }
    return audiences;
};

const invalidCredential = () => {
    const error = new Error('The identity credential is invalid or expired.') as Error & {
        statusCode?: number;
    };
    error.statusCode = 401;
    return error;
};

const normalizedVerifiedEmail = (
    email: unknown,
    verified: unknown
) => {
    const isVerified = verified === true || verified === 'true';
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!isVerified || !normalized.includes('@')) {
        throw invalidCredential();
    }
    return normalized;
};

/** Verifies Apple signature, audience, lifetime, issuer, and the request-bound nonce. */
export const verifyAppleIdentity = async (
    identityToken: string,
    rawNonce: string
): Promise<VerifiedFederatedIdentity> => {
    if (!identityToken || identityToken.length > 10_000 || !rawNonce || rawNonce.length > 256) {
        throw invalidCredential();
    }
    const nonceHash = crypto.createHash('sha256').update(rawNonce, 'utf8').digest('hex');
    try {
        const { payload } = await jwtVerify(identityToken, appleKeys, {
            issuer: 'https://appleid.apple.com',
            audience: configuredAudiences('APPLE_CLIENT_IDS'),
            algorithms: ['RS256']
        });
        if (!payload.sub || payload.nonce !== nonceHash) {
            throw invalidCredential();
        }
        return {
            provider: 'apple',
            subject: payload.sub,
            email: normalizedVerifiedEmail(payload.email, payload.email_verified)
        };
    } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode) throw error;
        throw invalidCredential();
    }
};

/** Uses Google's verifier and additionally binds the token to the initiating nonce. */
export const verifyGoogleIdentity = async (
    identityToken: string,
    nonce: string
): Promise<VerifiedFederatedIdentity> => {
    if (!identityToken || identityToken.length > 10_000 || !nonce || nonce.length > 256) {
        throw invalidCredential();
    }
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: identityToken,
            audience: configuredAudiences('GOOGLE_CLIENT_IDS')
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || payload.nonce !== nonce) {
            throw invalidCredential();
        }
        return {
            provider: 'google',
            subject: payload.sub,
            email: normalizedVerifiedEmail(payload.email, payload.email_verified)
        };
    } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode) throw error;
        throw invalidCredential();
    }
};
