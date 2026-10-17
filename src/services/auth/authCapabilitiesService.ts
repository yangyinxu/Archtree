import { hasAuthEmailConfiguration } from './authEmailService';

export interface AuthenticationCapabilities {
    password: boolean;
    emailRegistration: boolean;
    apple: boolean;
    google: boolean;
    passkey: boolean;
}

const hasValues = (value: string | undefined) =>
    String(value ?? '').split(',').some(item => item.trim().length > 0);

/** Derives public availability flags without exposing provider identifiers or secrets. */
export const getAuthenticationCapabilities = (
    environment: NodeJS.ProcessEnv = process.env
): AuthenticationCapabilities => ({
    password: true,
    emailRegistration: hasAuthEmailConfiguration(environment),
    apple: hasValues(environment.APPLE_CLIENT_IDS),
    google: hasValues(environment.GOOGLE_CLIENT_IDS),
    passkey: Boolean(
        String(environment.WEBAUTHN_RP_ID ?? '').trim() &&
        String(environment.WEBAUTHN_ORIGIN ?? '').trim().startsWith('https://')
    )
});

/** Reports only methods with a complete browser-to-HttpOnly-session flow. */
export const getBrowserAuthenticationCapabilities = (
    environment: NodeJS.ProcessEnv = process.env
): AuthenticationCapabilities => ({
    password: true,
    emailRegistration: hasAuthEmailConfiguration(environment),
    // Native provider verification is not a browser cookie flow. These stay
    // hidden until dedicated Web initiation and cookie completion both exist.
    apple: false,
    google: false,
    passkey: false
});
