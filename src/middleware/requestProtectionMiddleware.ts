import { NextFunction, Request, RequestHandler, Response } from 'express';
import crypto from 'crypto';

type WindowEntry = {
    count: number;
    resetsAt: number;
};

const windows = new Map<string, WindowEntry>();
let lastSweep = 0;

const clientKey = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

export const rateLimit = (
    scope: string,
    maximumRequests: number,
    windowMs: number
): RequestHandler => {
    return (req, res, next) => {
        const now = Date.now();
        if (now - lastSweep > 5 * 60_000) {
            lastSweep = now;
            for (const [key, entry] of windows) {
                if (entry.resetsAt <= now) windows.delete(key);
            }
        }

        const key = `${scope}:${clientKey(req)}`;
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
            res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)));
            return res.status(429).json({ message: 'Too many requests. Please try again later.' });
        }
        return next();
    };
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
            res.off('finish', release);
            res.off('close', release);
            const remainingClient = (activeByScopeAndClient.get(scopedClient) ?? 1) - 1;
            const remainingGlobal = (activeByScope.get(scope) ?? 1) - 1;
            if (remainingClient <= 0) activeByScopeAndClient.delete(scopedClient);
            else activeByScopeAndClient.set(scopedClient, remainingClient);
            if (remainingGlobal <= 0) activeByScope.delete(scope);
            else activeByScope.set(scope, remainingGlobal);
        };
        res.once('finish', release);
        res.once('close', release);
        return next();
    };
};

export const asyncHandler = (
    handler: (req: Request, res: Response, next: NextFunction) => unknown
): RequestHandler => {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
};

export const authRateLimit = rateLimit('auth', 20, 15 * 60_000);
export const authAccountRateLimit = accountRateLimit('auth-account', 10, 15 * 60_000);
export const authConcurrencyLimit = limitConcurrency('auth-password', 2, 20);
export const publicReadRateLimit = rateLimit('public-read', 120, 60_000);
export const uploadRateLimit = rateLimit('upload', 20, 60 * 60_000);
export const uploadConcurrencyLimit = limitConcurrency('upload', 1, 4);
export const reconciliationConcurrencyLimit = limitConcurrency('reconciliation', 1, 1);

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
