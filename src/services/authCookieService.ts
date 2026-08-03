import { NextFunction, Request, Response } from 'express';
import { SessionTokens } from './authSessionService';

const cookieSecurity = () => process.env.NODE_ENV === 'production' ? '; Secure' : '';

export interface BrowserMutationRequestMetadata {
    contentType?: string;
    origin?: string;
    requestOrigin: string;
    secFetchSite?: string;
    allowedOrigins?: string[];
}

const crossSiteRejection = () => ({
    status: 403,
    message: 'Cross-site browser authentication is not allowed.'
});

/** Builds the exact cookie headers used for a newly created or rotated browser session. */
export const browserSessionCookieHeaders = (
    tokens: Pick<
        SessionTokens,
        'accessToken' | 'accessTokenExpiresIn' | 'refreshToken' | 'refreshTokenExpiresAt'
    >,
    now = Date.now()
) => {
    const remainingRefreshSeconds = Math.floor(
        (new Date(tokens.refreshTokenExpiresAt).getTime() - now) / 1000
    );
    const refreshMaxAge = Number.isFinite(remainingRefreshSeconds)
        ? Math.max(0, remainingRefreshSeconds)
        : 0;
    return [
        `session_token=${encodeURIComponent(tokens.accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${tokens.accessTokenExpiresIn}${cookieSecurity()}`,
        `refresh_token=${encodeURIComponent(tokens.refreshToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${refreshMaxAge}${cookieSecurity()}`
    ];
};

/** Builds expired credential cookies without needing the session database. */
export const clearedBrowserSessionCookieHeaders = () => [
    `session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity()}`,
    `refresh_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecurity()}`
];

/** Reads one named cookie without adding a general cookie-parser dependency. */
export const getCookieValue = (req: Request, key: string) => {
    const cookieHeader = req.get('Cookie');
    if (!cookieHeader) {
        return '';
    }

    const pair = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${key}=`));
    if (!pair) {
        return '';
    }

    try {
        return decodeURIComponent(pair.substring(key.length + 1));
    } catch {
        // A malformed cookie is an invalid credential, not a server error.
        return '';
    }
};

/** Sets browser cookies with separate access and refresh lifetimes. */
export const setBrowserSessionCookies = (
    res: Response,
    tokens: Pick<
        SessionTokens,
        'accessToken' | 'accessTokenExpiresIn' | 'refreshToken' | 'refreshTokenExpiresAt'
    >
) => {
    res.setHeader('Set-Cookie', browserSessionCookieHeaders(tokens));
};

/** Clears both browser credentials even when server revocation is unavailable. */
export const clearBrowserSessionCookies = (res: Response) => {
    res.setHeader('Set-Cookie', clearedBrowserSessionCookieHeaders());
};

/** Prevents browser authentication mutations from being submitted cross-site. */
const originMutationRejection = (
    metadata: BrowserMutationRequestMetadata,
    requireBrowserProof: boolean
) => {
    const configuredOrigins = metadata.allowedOrigins ?? [];
    const allowedOrigins = new Set(
        [metadata.requestOrigin, ...configuredOrigins]
            .map((value) => {
                try {
                    return new URL(value).origin;
                } catch {
                    return '';
                }
            })
            .filter(Boolean)
    );
    if (metadata.origin) {
        let normalizedOrigin = '';
        try {
            normalizedOrigin = new URL(metadata.origin).origin;
        } catch {
            return crossSiteRejection();
        }
        return allowedOrigins.has(normalizedOrigin)
            ? null
            : crossSiteRejection();
    }

    // Fetch Metadata distinguishes a same-origin browser request from a sibling
    // origin on the same registrable domain, which SameSite cookies do not.
    const fetchSite = String(metadata.secFetchSite ?? '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return crossSiteRejection();
    }
    if (requireBrowserProof && !fetchSite) return crossSiteRejection();
    return null;
};

/** Validates the JSON and origin contract for browser-session mutations. */
export const browserMutationRejection = (metadata: BrowserMutationRequestMetadata) => {
    const contentType = String(metadata.contentType ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (contentType !== 'application/json') {
        return { status: 415, message: 'Browser authentication requires JSON.' };
    }
    // Non-browser JSON clients may omit Origin when no Fetch Metadata says cross-site.
    return originMutationRejection(metadata, false);
};

/** Requires both JSON and explicit same-origin browser evidence. */
export const sameOriginBrowserJsonMutationRejection = (
    metadata: BrowserMutationRequestMetadata
) => {
    const contentType = String(metadata.contentType ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (contentType !== 'application/json') {
        return { status: 415, message: 'Browser request requires JSON.' };
    }
    return originMutationRejection(metadata, true);
};

/** Requires explicit browser same-origin evidence for a cookie-authenticated write. */
export const cookieMutationRejection = (metadata: BrowserMutationRequestMetadata) =>
    originMutationRejection(metadata, true);

/** Reads the deployment's optional exact allowlist for listener origins. */
const configuredBrowserOrigins = () => String(process.env.BROWSER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

/** Applies JSON and Origin/Fetch-Metadata checks to cookie-mutating endpoints. */
export const requireSameOriginBrowserMutation = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    const host = req.get('Host');
    if (!host) {
        return res.status(400).json({ message: 'A valid request host is required.' });
    }
    const rejection = browserMutationRejection({
        contentType: req.get('Content-Type'),
        origin: req.get('Origin'),
        requestOrigin: `${req.protocol}://${host}`,
        secFetchSite: req.get('Sec-Fetch-Site'),
        allowedOrigins: configuredBrowserOrigins()
    });
    if (rejection) {
        return res.status(rejection.status).json({ message: rejection.message });
    }
    return next();
};

/** Protects anonymous browser JSON writes that must not accept originless clients. */
export const requireStrictSameOriginBrowserMutation = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    const host = req.get('Host');
    if (!host) {
        return res.status(400).json({ message: 'A valid request host is required.' });
    }
    const rejection = sameOriginBrowserJsonMutationRejection({
        contentType: req.get('Content-Type'),
        origin: req.get('Origin'),
        requestOrigin: `${req.protocol}://${host}`,
        secFetchSite: req.get('Sec-Fetch-Site'),
        allowedOrigins: configuredBrowserOrigins()
    });
    if (rejection) {
        return res.status(rejection.status).json({ message: rejection.message });
    }
    return next();
};

/** Applies same-origin proof to legacy server-rendered authentication forms. */
export const requireSameOriginBrowserFormMutation = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    const host = req.get('Host');
    if (!host) {
        return res.status(400).json({ message: 'A valid request host is required.' });
    }
    const rejection = cookieMutationRejection({
        origin: req.get('Origin'),
        requestOrigin: `${req.protocol}://${host}`,
        secFetchSite: req.get('Sec-Fetch-Site'),
        allowedOrigins: configuredBrowserOrigins()
    });
    if (rejection) {
        return res.status(rejection.status).json({ message: rejection.message });
    }
    return next();
};

/** Keeps signed-out session probes out of authentication attempt rate limits. */
export const requireBrowserRefreshCookie = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    if (!getCookieValue(req, 'refresh_token')) {
        return res.status(401).json({ message: 'Authentication failed.' });
    }
    return next();
};

/** Protects every unsafe API request that authenticates through an access cookie. */
export const requireSameOriginCookieMutation = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('Authorization')?.startsWith('Bearer ')) return next();
    if (!getCookieValue(req, 'session_token')) return next();

    setBrowserSessionPrivacyHeaders(res);
    const host = req.get('Host');
    if (!host) {
        return res.status(400).json({ message: 'A valid request host is required.' });
    }
    const rejection = cookieMutationRejection({
        origin: req.get('Origin'),
        requestOrigin: `${req.protocol}://${host}`,
        secFetchSite: req.get('Sec-Fetch-Site'),
        allowedOrigins: configuredBrowserOrigins()
    });
    if (rejection) {
        return res.status(rejection.status).json({ message: rejection.message });
    }
    return next();
};

/** Marks account identity responses as private and non-cacheable. */
export const setBrowserSessionPrivacyHeaders = (res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
};
