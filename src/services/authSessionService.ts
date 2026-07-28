import crypto from 'crypto';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import AuthSession from '../models/authSession';
import User from '../models/user';

export interface SessionUser {
    _id: { toString(): string };
    email: string;
    role?: string;
}

export interface AccessTokenPayload {
    userId: string;
    email: string;
    role: string;
    sessionId: string;
    tokenType: 'access';
}

export interface SessionTokens {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresAt: string;
    sessionId: string;
}

const minutesToSeconds = 60;
const daysToMilliseconds = 24 * 60 * 60 * 1000;

/** Reads a bounded positive integer duration from environment configuration. */
const boundedDuration = (value: string | undefined, fallback: number, maximum: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.max(1, Math.min(maximum, Math.floor(parsed)))
        : fallback;
};

/** Uses a seconds-scale lifetime in development so refresh rotation can be tested quickly. */
export const accessTokenDurationSeconds = () => {
    if (process.env.NODE_ENV !== 'production' && process.env.ACCESS_TOKEN_SECONDS) {
        return boundedDuration(process.env.ACCESS_TOKEN_SECONDS, 15, 300);
    }
    return boundedDuration(process.env.ACCESS_TOKEN_MINUTES, 15, 60) * minutesToSeconds;
};

export const refreshSessionDurationMilliseconds = () =>
    boundedDuration(
        process.env.REFRESH_SESSION_DAYS ?? process.env.SESSION_DAYS,
        30,
        90
    ) * daysToMilliseconds;

export const allowsLegacyAuthTokens = () =>
    String(process.env.ALLOW_LEGACY_AUTH_TOKENS ?? '').toLowerCase() === 'true';

/** Refuses to start auth token operations without an explicit signing secret. */
export const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        const error = new Error('JWT secret is not configured.') as Error & { statusCode?: number };
        error.statusCode = 500;
        throw error;
    }
    return secret;
};

const hashRefreshToken = (token: string) =>
    crypto.createHash('sha256').update(token, 'utf8').digest('hex');

const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');

/** Signs a short-lived access token bound to a revocable server session. */
const signAccessToken = (user: SessionUser, sessionId: string) => {
    const role = user.role ?? 'user';
    return jwt.sign(
        {
            userId: user._id.toString(),
            email: user.email,
            role,
            sessionId,
            tokenType: 'access'
        } satisfies AccessTokenPayload,
        getJwtSecret(),
        { expiresIn: accessTokenDurationSeconds() }
    );
};

/** Issues a temporary legacy token only during an explicitly enabled app migration. */
export const createLegacyMigrationToken = (user: SessionUser) => {
    if (!allowsLegacyAuthTokens()) {
        return null;
    }
    const legacyDays = boundedDuration(process.env.SESSION_DAYS, 30, 90);
    return jwt.sign(
        {
            userId: user._id.toString(),
            email: user.email,
            role: user.role ?? 'user'
        },
        getJwtSecret(),
        { expiresIn: legacyDays * 24 * 60 * 60 }
    );
};

const userAgentFrom = (req?: Request) =>
    String(req?.get('User-Agent') ?? '').trim().slice(0, 256) || undefined;

/** Creates the initial access/refresh pair for a newly authenticated user. */
export const createSession = async (user: SessionUser, req?: Request): Promise<SessionTokens> => {
    const refreshToken = newRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + refreshSessionDurationMilliseconds());
    const sessionId = await AuthSession.create(
        user._id.toString(),
        hashRefreshToken(refreshToken),
        refreshTokenExpiresAt,
        userAgentFrom(req)
    );

    return {
        accessToken: signAccessToken(user, sessionId),
        refreshToken,
        accessTokenExpiresIn: accessTokenDurationSeconds(),
        refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
        sessionId
    };
};

/** Rotates a refresh token atomically and returns a fresh short-lived access token. */
export const refreshSession = async (refreshToken: string): Promise<SessionTokens | null> => {
    if (!refreshToken || refreshToken.length > 512) {
        return null;
    }

    const replacementToken = newRefreshToken();
    const session = await AuthSession.rotate(
        hashRefreshToken(refreshToken),
        hashRefreshToken(replacementToken)
    );
    if (!session) {
        return null;
    }

    const user = await User.findById(session.userId) as SessionUser | null;
    if (!user) {
        await AuthSession.revokeById(session.userId, session._id.toString());
        return null;
    }

    return {
        accessToken: signAccessToken(user, session._id.toString()),
        refreshToken: replacementToken,
        accessTokenExpiresIn: accessTokenDurationSeconds(),
        refreshTokenExpiresAt: session.expiresAt.toISOString(),
        sessionId: session._id.toString()
    };
};

/** Revokes the session identified by an opaque refresh token. */
export const revokeRefreshSession = async (refreshToken: string) => {
    if (!refreshToken || refreshToken.length > 512) {
        return;
    }
    await AuthSession.revokeByRefreshTokenHash(hashRefreshToken(refreshToken));
};
