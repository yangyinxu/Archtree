import { NextFunction, Request, RequestHandler, Response } from 'express';
import crypto from 'crypto';
import { onRequestWorkComplete, runRequestWork } from '../services/serverLifecycleService';
import type { AuthenticatedRequest } from './authMiddleware';

type WindowEntry = {
    count: number;
    resetsAt: number;
};

const windows = new Map<string, WindowEntry>();
let lastSweep = 0;

/** Resets process-local rate windows so sequential integration cases remain isolated. */
export const resetRateLimitWindowsForTests = () => {
    windows.clear();
    lastSweep = 0;
};

const clientKey = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

/**
 * Keys a window by the account that database-backed authentication already
 * resolved, so listeners sharing one NAT or proxy address keep separate
 * budgets. Requests without a verified account fall back to the client IP.
 * The prefixes keep an address bucket from ever matching an account bucket.
 */
export const accountOrClientKey = (req: Request) => {
    const userId = (req as AuthenticatedRequest).auth?.userId;
    return userId ? `account:${userId}` : `ip:${clientKey(req)}`;
};

/** Counts requests per scope in a fixed window keyed by client IP unless `keyFor` says otherwise. */
export const rateLimit = (
    scope: string,
    maximumRequests: number,
    windowMs: number,
    onRejected?: (req: Request, res: Response, retryAfterSeconds: number) => unknown,
    keyFor: (req: Request) => string = clientKey
): RequestHandler => {
    return (req, res, next) => {
        const now = Date.now();
        if (now - lastSweep > 5 * 60_000) {
            lastSweep = now;
            for (const [key, entry] of windows) {
                if (entry.resetsAt <= now) windows.delete(key);
            }
        }

        const key = `${scope}:${keyFor(req)}`;
        const current = windows.get(key);
        const entry = !current || current.resetsAt <= now
            ? { count: 0, resetsAt: now + windowMs }
            : current;
        entry.count += 1;
        windows.set(key, entry);

        res.setHeader('RateLimit-Limit', maximumRequests);
        res.setHeader('RateLimit-Remaining', Math.max(0, maximumRequests - entry.count));
        res.setHeader('RateLimit-Reset', Math.ceil(entry.resetsAt / 1000));
        if (entry.count > maximumRequests) {
            const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetsAt - now) / 1000));
            res.setHeader('Retry-After', retryAfterSeconds);
            if (onRejected) return onRejected(req, res, retryAfterSeconds);
            return res.status(429).json({ message: 'Too many requests. Please try again later.' });
        }
        return next();
    };
};

/** Counts one attempt in a window keyed by a digest, never the raw identifier or credential. */
const consumeDigestKeyedAttempt = (
    scope: string,
    identifier: string,
    maximumRequests: number,
    windowMs: number,
    res: Response,
    next: NextFunction
) => {
    const digest = crypto.createHash('sha256').update(identifier, 'utf8').digest('hex');
    const now = Date.now();
    const key = `${scope}:${digest}`;
    const current = windows.get(key);
    const entry = !current || current.resetsAt <= now
        ? { count: 0, resetsAt: now + windowMs }
        : current;
    entry.count += 1;
    windows.set(key, entry);

    if (entry.count > maximumRequests) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)));
        return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }
    return next();
};

/** Limits credential attempts across IPs without retaining the raw identifier. */
const accountRateLimit = (
    scope: string,
    maximumRequests: number,
    windowMs: number
): RequestHandler => {
    return (req, res, next) => {
        const identifier = String(req.body?.identifier ?? req.body?.email ?? req.body?.username ?? '')
            .trim()
            .toLowerCase();
        if (!identifier) {
            return next();
        }
        return consumeDigestKeyedAttempt(scope, identifier, maximumRequests, windowMs, res, next);
    };
};

/**
 * Limits email-code attempts per account across IPs. It keys only on the
 * `email` field, normalized exactly as the email-auth controllers normalize it
 * before the account lookup, and ignores `identifier` and `username`.
 *
 * Mount it after the route's express-validator chain. That chain rewrites
 * `req.body.email` with normalizeEmail(), which folds dots, +tags and
 * googlemail.com into one address. Counting the raw body instead would give
 * each extra field or address variant a fresh bucket for the same account.
 */
const emailAccountRateLimit = (
    scope: string,
    maximumRequests: number,
    windowMs: number
): RequestHandler => {
    return (req, res, next) => {
        const email = String(req.body?.email ?? '').trim().toLowerCase();
        if (!email) {
            // No account can be resolved; the controller rejects the request as invalid.
            return next();
        }
        return consumeDigestKeyedAttempt(scope, email, maximumRequests, windowMs, res, next);
    };
};

/**
 * Limits refresh attempts per presented refresh token, so listeners behind one
 * shared address (carrier NAT, offices) do not spend each other's budget and a
 * replayed token cannot be retried without bound. The token is keyed only by
 * digest. A request without a usable token falls back to its client address.
 */
const refreshCredentialLimit = (
    scope: string,
    maximumRequests: number,
    windowMs: number
): RequestHandler => {
    return (req, res, next) => {
        const token = req.body?.refreshToken;
        const credential = typeof token === 'string' && token.length > 0 && token.length <= 512
            ? `token:${token}`
            : `client:${clientKey(req)}`;
        return consumeDigestKeyedAttempt(scope, credential, maximumRequests, windowMs, res, next);
    };
};

/** Registration links, already-registered notices and verification links per address and window. */
export const linkEmailBudgetPerWindow = 3;
const linkEmailBudgetWindowMs = 15 * 60_000;

/**
 * Spends one unit of the per-address budget shared by every link email
 * (registration links, already-registered notices and verification links).
 * Resolves false when the address has no budget left; callers then send
 * nothing, while their response stays the same. Keyed by a digest of the
 * normalized address, process-local like the other limiters (production is a
 * single instance), and cleared by `resetRateLimitWindowsForTests`.
 */
export const consumeLinkEmailBudget = (email: string) => {
    const digest = crypto.createHash('sha256').update(String(email ?? '').trim().toLowerCase(), 'utf8').digest('hex');
    const now = Date.now();
    const key = `auth-link-email:${digest}`;
    const current = windows.get(key);
    const entry = !current || current.resetsAt <= now
        ? { count: 0, resetsAt: now + linkEmailBudgetWindowMs }
        : current;
    if (entry.count >= linkEmailBudgetPerWindow) return false;
    entry.count += 1;
    windows.set(key, entry);
    return true;
};

/** Rejects production credentials sent without TLS after trusted-proxy resolution. */
export const requireSecureAuthTransport: RequestHandler = (req, res, next) => {
    if (process.env.NODE_ENV === 'production' && !req.secure) {
        return res.status(426).json({ message: 'Secure authentication transport is required.' });
    }
    return next();
};

const activeByScopeAndClient = new Map<string, number>();
const activeByScope = new Map<string, number>();

export const limitConcurrency = (
    scope: string,
    perClientLimit: number,
    globalLimit: number
): RequestHandler => {
    return (req, res, next) => {
        const scopedClient = `${scope}:${clientKey(req)}`;
        const clientActive = activeByScopeAndClient.get(scopedClient) ?? 0;
        const globalActive = activeByScope.get(scope) ?? 0;
        if (clientActive >= perClientLimit || globalActive >= globalLimit) {
            res.setHeader('Retry-After', '2');
            return res.status(429).json({ message: 'Too many concurrent requests.' });
        }

        activeByScopeAndClient.set(scopedClient, clientActive + 1);
        activeByScope.set(scope, globalActive + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const remainingClient = (activeByScopeAndClient.get(scopedClient) ?? 1) - 1;
            const remainingGlobal = (activeByScope.get(scope) ?? 1) - 1;
            if (remainingClient <= 0) activeByScopeAndClient.delete(scopedClient);
            else activeByScopeAndClient.set(scopedClient, remainingClient);
            if (remainingGlobal <= 0) activeByScope.delete(scope);
            else activeByScope.set(scope, remainingGlobal);
        };
        onRequestWorkComplete(req, res, release);
        return next();
    };
};

export const asyncHandler = (
    handler: (req: Request, res: Response, next: NextFunction) => unknown
): RequestHandler => {
    return (req, res, next) => {
        return runRequestWork(req, () => handler(req, res, next)).catch(next);
    };
};

export const authRateLimit = rateLimit('auth', 20, 15 * 60_000);
export const browserRefreshRateLimit = rateLimit('browser-refresh', 120, 15 * 60_000);
/**
 * Bounds native token refresh per client address with a ceiling far above one
 * address's normal refresh traffic, so random-token floods stay bounded. It is
 * separate from the login 'auth' bucket: failed sign-ins cannot block refresh
 * and refresh traffic cannot consume sign-in attempts.
 */
export const refreshClientRateLimit = rateLimit('refresh-client', 600, 15 * 60_000);
/** Keys native token refresh on the presented refresh token; see refreshCredentialLimit. */
export const refreshCredentialRateLimit = refreshCredentialLimit('refresh-credential', 10, 15 * 60_000);
/** Keys login attempts on the submitted `identifier`, falling back to `email` or `username`. */
export const authAccountRateLimit = accountRateLimit('auth-account', 10, 15 * 60_000);
/**
 * Keys registration-link, verification-link and recovery attempts on the validated account email.
 * It uses the same 'auth-account' scope, so these routes and an identifier
 * login that submits the same normalized address draw from one budget. Those
 * routes mount it after `rejectUndeliverableEmailDomain`, so a request rejected
 * because its domain cannot receive mail never counts here.
 */
export const authEmailAccountRateLimit = emailAccountRateLimit('auth-account', 10, 15 * 60_000);
export const authConcurrencyLimit = limitConcurrency('auth-password', 2, 20);
export const publicReadRateLimit = rateLimit('public-read', 120, 60_000);
/** Bounds substring search work independently of lightweight catalog metadata reads. */
export const searchConcurrencyLimit = limitConcurrency('catalog-search', 2, 8);
/** Bounds private Playlist reads and writes before they consume database work. */
export const playlistRateLimit = rateLimit('playlist', 240, 60_000);
/** Prevents one client from occupying the transactional Playlist write pool. */
export const playlistMutationConcurrencyLimit = limitConcurrency('playlist-mutation', 4, 40);
/** Bounds anonymous listener diagnostics before any request body is parsed. */
export const listenerTelemetryRateLimit = rateLimit('listener-telemetry', 20, 60_000);
/** Bounds account-owned avatar mutations; administrator catalog uploads have no hourly quota. */
export const uploadRateLimit = rateLimit('upload', 20, 60 * 60_000);
/** Prevents simultaneous multipart and storage work from exhausting shared resources. */
const uploadConcurrencyLimiter = limitConcurrency('upload', 1, 4);
export const uploadConcurrencyLimit: RequestHandler = (req, res, next) =>
    uploadConcurrencyLimiter(req, res, next);
/** Prevents telemetry uploads from occupying meaningful API capacity. */
export const listenerTelemetryConcurrencyLimit = limitConcurrency('listener-telemetry', 2, 10);
export const reconciliationConcurrencyLimit = limitConcurrency('reconciliation', 1, 1);
/** Bounds existing-file download and analysis without consuming multipart upload capacity. */
const roomAudioAnalysisLimiter = limitConcurrency('room-audio-analysis', 1, 1);
export const roomAudioAnalysisConcurrencyLimit: RequestHandler = (req, res, next) =>
    roomAudioAnalysisLimiter(req, res, next);

const requestAbortControllers = new WeakMap<Request, AbortController>();

export const attachRequestAbortSignal = (req: Request, res: Response, next: NextFunction) => {
    const controller = new AbortController();
    requestAbortControllers.set(req, controller);
    const abort = () => {
        if (!res.writableEnded) controller.abort();
    };
    const onClose = () => {
        abort();
        cleanup();
    };
    const cleanup = () => {
        req.off('aborted', abort);
        res.off('close', onClose);
        res.off('finish', cleanup);
        requestAbortControllers.delete(req);
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    res.once('finish', cleanup);
    return next();
};

export const getRequestAbortSignal = (req: Request) => requestAbortControllers.get(req)?.signal;
