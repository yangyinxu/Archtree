import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/user';
import AuthSession from '../models/authSession';
import {
    allowsLegacyAuthTokens,
    getJwtSecret,
    refreshSession
} from '../services/authSessionService';
import { getCookieValue, setBrowserSessionCookies } from '../services/authCookieService';

interface JwtPayload {
    userId: string;
    email: string;
    role?: string;
    sessionId?: string;
    tokenType?: 'access';
}

export interface AuthContext {
    userId: string;
    email: string;
    role: string;
}

export interface AuthenticatedRequest extends Request {
    auth?: AuthContext;
}

/** Prefers API bearer authentication and falls back to the browser access cookie. */
const getTokenFromRequest = (req: Request) => {
    const authHeader = req.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
    }

    return getCookieValue(req, 'session_token');
};

/** Verifies both the JWT and its revocable backing session before authorizing. */
const attachAuthContext = async (req: Request, replacementToken?: string) => {
    const token = replacementToken ?? getTokenFromRequest(req);
    if (!token) {
        return null;
    }

    const decodedToken = jwt.verify(token, getJwtSecret()) as JwtPayload;
    if (!decodedToken?.userId || !decodedToken?.email) {
        return null;
    }

    if (decodedToken.sessionId && decodedToken.tokenType === 'access') {
        const session = await AuthSession.findActiveById(decodedToken.sessionId);
        if (!session || session.userId !== decodedToken.userId) {
            return null;
        }
    } else if (!allowsLegacyAuthTokens()) {
        return null;
    }

    const user = await User.findById(decodedToken.userId);
    if (!user) {
        return null;
    }

    (req as AuthenticatedRequest).auth = {
        userId: decodedToken.userId,
        email: user.email,
        role: user.role ?? 'user'
    };

    return (req as AuthenticatedRequest).auth;
};

/** Refreshes an expired browser access cookie without exposing the refresh token. */
const attachOrRefreshBrowserAuth = async (req: Request, res: Response) => {
    try {
        const auth = await attachAuthContext(req);
        if (auth) {
            return auth;
        }
    } catch {
        // An expired or malformed access cookie can still have a valid refresh session.
    }

    const refreshToken = getCookieValue(req, 'refresh_token');
    if (!refreshToken) {
        return null;
    }
    const tokens = await refreshSession(refreshToken);
    if (!tokens) {
        return null;
    }
    setBrowserSessionCookies(res, tokens);
    return attachAuthContext(req, tokens.accessToken);
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = await attachAuthContext(req);
        if (!auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Authentication failed.' });
    }
};

export const requireAuthForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = await attachOrRefreshBrowserAuth(req, res);
        if (!auth) {
            const returnTo = encodeURIComponent(req.originalUrl || '/content/manage');
            return res.redirect(`/auth/login-web?returnTo=${returnTo}`);
        }

        return next();
    } catch (error) {
        const returnTo = encodeURIComponent(req.originalUrl || '/content/manage');
        return res.redirect(`/auth/login-web?returnTo=${returnTo}`);
    }
};

export const attachOptionalAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
        await attachOrRefreshBrowserAuth(req, res);
    } catch (error) {
        // Intentionally ignore optional auth parsing errors.
    }

    return next();
};

export const ensureOwnerOrAdmin = (req: AuthenticatedRequest, ownerId: string) => {
    if (!req.auth) {
        return false;
    }

    if (req.auth.role === 'admin') {
        return true;
    }

    return req.auth.userId === ownerId;
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
        return res.status(401).json({ message: 'Missing or invalid credentials.' });
    }
    if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    return next();
};
