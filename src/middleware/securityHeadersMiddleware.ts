import { Request, RequestHandler } from 'express';

/**
 * Allows the listener's external artwork and local previews while keeping code,
 * API calls, forms, and audio on the Archtree origin.
 */
export const buildContentSecurityPolicy = (allowInlineStyles = false) => [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data: blob: https:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    allowInlineStyles
        ? "style-src 'self' 'unsafe-inline'"
        : "style-src 'self'",
    allowInlineStyles
        ? "style-src-attr 'unsafe-inline'"
        : "style-src-attr 'none'",
    "worker-src 'self' blob:"
].join('; ');

/** Restricts the inline-style compatibility policy to legacy server-rendered HTML. */
export const requiresInlineStyleCompatibility = (req: Request) => {
    if (req.path === '/auth/login-web') return true;
    const isHtmlRead = req.method === 'GET' || req.method === 'HEAD';
    if (isHtmlRead && (
        req.path === '/content/manage'
        || req.path.startsWith('/content/manage/')
    )) return true;
    if (req.path !== '/admin/audio-storage/reconciliation') return false;
    return isHtmlRead
        && req.query.format !== 'json'
        && req.accepts(['html', 'json']) === 'html';
};

/** Limits browser capabilities to those needed by playback and local authentication. */
export const permissionsPolicy = [
    'accelerometer=()',
    'autoplay=(self)',
    'camera=()',
    'display-capture=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'microphone=()',
    'payment=()',
    'publickey-credentials-get=(self)',
    'usb=()'
].join(', ');

/** Applies deployment-wide browser hardening before static files and routers respond. */
export const applySecurityHeaders: RequestHandler = (req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        buildContentSecurityPolicy(requiresInlineStyleCompatibility(req))
    );
    res.setHeader('Permissions-Policy', permissionsPolicy);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
};
