import { createHmac, timingSafeEqual } from 'node:crypto';
import { SocialError } from '../../contracts/socialV1';

/** Domain-separated signatures prevent scope/cursor tokens from becoming access credentials. */
export const signSocialToken = (payload: Record<string, unknown>, secret: string): string => {
    if (!secret) throw new SocialError(503, 'social_unavailable');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`archtree-social-v1:${body}`).digest('base64url');
    return `${body}.${signature}`;
};

/** Authenticate bounded bytes before decoding; callers validate audience, owner and logical expiry. */
export const readSocialToken = (token: string, secret: string): Record<string, unknown> | null => {
    if (!secret || !/^[A-Za-z0-9_-]{1,950}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [body, signature] = token.split('.');
    const expected = createHmac('sha256', secret).update(`archtree-social-v1:${body}`).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch { return null; }
};
