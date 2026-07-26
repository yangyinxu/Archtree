import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/user';

interface JwtPayload {
    userId: string;
    email: string;
    role?: string;
}

interface ErrorWithStatusCode extends Error {
    statusCode?: number;
}

export interface AuthContext {
    userId: string;
    email: string;
    role: string;
}

export interface AuthenticatedRequest extends Request {
    auth?: AuthContext;
}

const getJwtSecret = () => {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        const error: ErrorWithStatusCode = new Error('JWT secret is not configured.');
        error.statusCode = 500;
        throw error;
    }
    return jwtSecret;
};

const getCookieValue = (req: Request, key: string) => {
    const cookieHeader = req.get('Cookie');
    if (!cookieHeader) {
        return '';
    }

    const pairs = cookieHeader.split(';').map((part) => part.trim());
    for (const pair of pairs) {
        if (!pair.startsWith(`${key}=`)) {
            continue;
        }

        return decodeURIComponent(pair.substring(key.length + 1));
    }

    return '';
};

const getTokenFromRequest = (req: Request) => {
    const authHeader = req.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
    }

    return getCookieValue(req, 'session_token');
};

const attachAuthContext = async (req: Request) => {
    const token = getTokenFromRequest(req);
    if (!token) {
        return null;
    }

    const decodedToken = jwt.verify(token, getJwtSecret()) as JwtPayload;
    if (!decodedToken?.userId || !decodedToken?.email) {
        return null;
    }

    const user = await User.findById(decodedToken.userId);
    if (!user) {
        return null;
    }

    (req as AuthenticatedRequest).auth = {
        userId: decodedToken.userId,
        email: decodedToken.email,
        role: user.role ?? 'user'
    };

    return (req as AuthenticatedRequest).auth;
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
        const auth = await attachAuthContext(req);
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
        await attachAuthContext(req);
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
