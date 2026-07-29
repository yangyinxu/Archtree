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
    emailRegistration: Boolean(
        String(environment.AUTH_EMAIL_FROM ?? '').trim() &&
        String(environment.AWS_REGION ?? '').trim() &&
        (environment.AUTH_CODE_PEPPER || environment.JWT_SECRET)
    ),
    apple: hasValues(environment.APPLE_CLIENT_IDS),
    google: hasValues(environment.GOOGLE_CLIENT_IDS),
    passkey: Boolean(
        String(environment.WEBAUTHN_RP_ID ?? '').trim() &&
        String(environment.WEBAUTHN_ORIGIN ?? '').trim().startsWith('https://')
    )
});
