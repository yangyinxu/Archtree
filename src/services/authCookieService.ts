import { Request, Response } from 'express';
import { SessionTokens } from './authSessionService';

const cookieSecurity = () => process.env.NODE_ENV === 'production' ? '; Secure' : '';

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
    return pair ? decodeURIComponent(pair.substring(key.length + 1)) : '';
};

/** Sets browser cookies with separate access and refresh lifetimes. */
export const setBrowserSessionCookies = (
    res: Response,
    tokens: Pick<
        SessionTokens,
        'accessToken' | 'accessTokenExpiresIn' | 'refreshToken' | 'refreshTokenExpiresAt'
    >
) => {
    const refreshMaxAge = Math.max(
        0,
        Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000)
    );
    res.setHeader('Set-Cookie', [
        `session_token=${encodeURIComponent(tokens.accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${tokens.accessTokenExpiresIn}${cookieSecurity()}`,
        `refresh_token=${encodeURIComponent(tokens.refreshToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${refreshMaxAge}${cookieSecurity()}`
    ]);
};

/** Clears both browser credentials even when server revocation is unavailable. */
export const clearBrowserSessionCookies = (res: Response) => {
    res.setHeader('Set-Cookie', [
        `session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity()}`,
        `refresh_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecurity()}`
    ]);
};
