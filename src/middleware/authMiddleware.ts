import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/user';
import AuthSession from '../models/authSession';
import {
    allowsLegacyAuthTokens,
    getJwtSecret
} from '../services/authSessionService';
import {
    getCookieValue,
    setBrowserSessionPrivacyHeaders
} from '../services/authCookieService';
import { normalizeUserRole, UserRole } from '../services/authRoleService';

interface JwtPayload {
    userId: string;
    email: string;
    role?: unknown;
    sessionId?: string;
    tokenType?: 'access';
}

export interface AuthContext {
    userId: string;
    email: string;
    role: UserRole;
    sessionId?: string;
}

export interface AuthenticatedRequest extends Request {
    auth?: AuthContext;
}

export const accountViewerMismatchCode = 'account_viewer_mismatch';

const sendAccountViewerMismatch = (res: Response) => res.status(409).json({
    code: accountViewerMismatchCode,
    message: 'The active account changed. Refresh the account before trying again.'
});

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
        role: normalizeUserRole(user.role),
        ...(decodedToken.sessionId ? { sessionId: decodedToken.sessionId } : {})
    };

    return (req as AuthenticatedRequest).auth;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    // Reuse the database-backed context installed by an earlier pre-body guard.
    if ((req as AuthenticatedRequest).auth) return next();
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

/** Rejects stale Web account actions while leaving Bearer-authenticated native clients compatible. */
export const requireCurrentAccountViewer = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
        return res.status(401).json({ message: 'Missing or invalid credentials.' });
    }
    if (req.get('Authorization')?.startsWith('Bearer ')) return next();
    const requestedViewer = String(req.get('X-Finitude-Account-Viewer') ?? '').trim();
    if (!requestedViewer || requestedViewer !== auth.userId) {
        return sendAccountViewerMismatch(res);
    }
    // Successful private Web responses echo the identity fence so the client can
    // reject a response that lost its account binding in transit.
    res.setHeader('X-Finitude-Account-Viewer', auth.userId);
    return next();
};

/** Fences personalized optional reads while retaining a truly anonymous response. */
export const requireCurrentAccountViewerWhenAuthenticated = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const auth = (req as AuthenticatedRequest).auth;
    const requestedViewer = String(req.get('X-Finitude-Account-Viewer') ?? '').trim();
    if (!auth) {
        return requestedViewer ? sendAccountViewerMismatch(res) : next();
    }
    return requireCurrentAccountViewer(req, res, next);
};

/** Authenticates the listener SPA from its HttpOnly access cookie only. */
export const requireBrowserAuth = async (req: Request, res: Response, next: NextFunction) => {
    setBrowserSessionPrivacyHeaders(res);
    try {
        const accessCookie = getCookieValue(req, 'session_token');
        const auth = await attachAuthContext(req, accessCookie);
        if (!auth) {
            return res.status(401).json({ message: 'Missing or invalid browser session.' });
        }

        return next();
    } catch {
        return res.status(401).json({ message: 'Authentication failed.' });
    }
};

export const requireAuthForWeb = async (req: Request, res: Response, next: NextFunction) => {
    // Content Manager authenticates before the application body parser runs.
    if ((req as AuthenticatedRequest).auth) return next();
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

/** Returns a non-HTML denial when an authenticated Web user is not an administrator. */
export const requireAdminForWeb = (req: Request, res: Response, next: NextFunction) => {
    setBrowserSessionPrivacyHeaders(res);
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
        return res.status(401).type('text/plain').send('Missing or invalid credentials.');
    }
    if (normalizeUserRole(auth.role) !== 'admin') {
        return res.status(403).type('text/plain').send('Administrator access is required.');
    }

    return next();
};

export const attachOptionalAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
        await attachAuthContext(req);
    } catch (error) {
        // Intentionally ignore optional auth parsing errors.
    }

    return next();
};

/** Adds an optional viewer without rotating cookies during a public GET. */
export const attachOptionalAccessAuth = async (req: Request, _res: Response, next: NextFunction) => {
    try {
        await attachAuthContext(req);
    } catch {
        // Expired or malformed credentials degrade to the public response.
    }

    return next();
};

/** Rejects a supplied invalid bearer token while allowing truly signed-out provider login. */
export const requireAuthWhenPresented = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (req.get('Authorization')) {
        return requireAuth(req, res, next);
    }
    return next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
        return res.status(401).json({ message: 'Missing or invalid credentials.' });
    }
    if (normalizeUserRole(auth.role) !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required.' });
    }

    return next();
};
