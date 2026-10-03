import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

type ConfigurationError = Error & { statusCode?: number };

const configurationError = () => {
    const error: ConfigurationError = new Error('Authentication email delivery is not configured.');
    error.statusCode = 503;
    return error;
};

/** Reports whether SES can send authentication mail and codes can be keyed (sender, region, pepper). */
export const hasAuthEmailDelivery = (
    environment: NodeJS.ProcessEnv = process.env
) => Boolean(
    String(environment.AUTH_EMAIL_FROM ?? '').trim()
    && String(environment.AWS_REGION ?? '').trim()
    && String(environment.AUTH_CODE_PEPPER ?? environment.JWT_SECRET ?? '').trim()
);

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Returns the validated origin used in emailed links, or null when
 * `AUTH_LINK_ORIGIN` is missing or invalid. Only `protocol://host[:port]` is
 * accepted, with no path, query, hash or credentials. `https:` is required;
 * `http:` is allowed only outside production for a loopback host. Links are
 * never built from request headers such as `Host` or `X-Forwarded-*`.
 */
export const authLinkOrigin = (environment: NodeJS.ProcessEnv = process.env): string | null => {
    const configured = String(environment.AUTH_LINK_ORIGIN ?? '').trim();
    if (!configured) return null;
    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        return null;
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    // `new URL` drops an empty query or fragment marker; the raw value must not carry one either.
    if (/[?#]/.test(configured)) return null;
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && environment.NODE_ENV !== 'production' && loopbackHosts.has(url.hostname)) {
        return url.origin;
    }
    return null;
};

/** Reports whether email registration links can be issued: delivery plus a valid link origin. */
export const hasAuthEmailConfiguration = (
    environment: NodeJS.ProcessEnv = process.env
) => hasAuthEmailDelivery(environment) && authLinkOrigin(environment) !== null;

/**
 * Fails before account work when the deployment cannot deliver auth mail.
 * Password recovery uses only this check, because its email holds a code.
 */
export const requireAuthEmailConfiguration = () => {
    const sender = String(process.env.AUTH_EMAIL_FROM ?? '').trim();
    if (!hasAuthEmailDelivery()) throw configurationError();
    return sender;
};

/** Fails before account work when emailed links cannot be built or delivered. */
export const requireAuthLinkConfiguration = () => {
    if (!hasAuthEmailConfiguration()) throw configurationError();
    return authLinkOrigin() as string;
};

/**
 * The plain-text authentication emails:
 * - `T1`: a registration link for an address without a usable account.
 * - `T2`: an "already registered" notice; it carries no token.
 * - `T3`: a verification link for an account created before verification existed.
 * - `resetCode`: the six-digit password-reset code.
 */
export type AuthEmailTemplate =
    | { template: 'T1'; token: string }
    | { template: 'T2' }
    | { template: 'T3'; token: string }
    | { template: 'resetCode'; code: string };

/** Builds the exact subject and body for a template; link templates need the configured origin. */
export const renderAuthEmail = (email: AuthEmailTemplate, origin: string | null) => {
    if (email.template === 'resetCode') {
        return {
            subject: 'Reset your Finitude password',
            text: `Use code ${email.code} to reset your password. This code expires soon. If you did not request it, you can ignore this email.`
        };
    }
    if (!origin) throw configurationError();
    const passwordRecoveryUrl = `${origin}/finitude/forgot-password`;
    if (email.template === 'T1') {
        return {
            subject: 'Finish creating your Finitude account',
            text: [
                'Someone asked to create a Finitude account with this email address.',
                '',
                'To choose your display name and password, open this link within 30 minutes:',
                `${origin}/finitude/register/complete#token=${email.token}`,
                '',
                'The link works once. If you didn\'t ask for this, ignore this email and no account will be created.'
            ].join('\n')
        };
    }
    if (email.template === 'T2') {
        return {
            subject: 'You already have a Finitude account',
            text: [
                'Someone asked to create a Finitude account with this email address, but it already has one. Nothing was changed.',
                '',
                'Log in on the web or in the Finitude app:',
                `${origin}/finitude/login`,
                '',
                'Forgot your password? Reset it here:',
                passwordRecoveryUrl,
                '',
                'If you didn\'t ask for this, you can ignore this email.'
            ].join('\n')
        };
    }
    return {
        subject: 'Verify your Finitude email',
        text: [
            'Your Finitude account needs a verified email address before you can sign in again.',
            '',
            'If you just tried to sign in or asked for this link, open it within 30 minutes and select Verify email, then sign in again:',
            `${origin}/finitude/verify-email#token=${email.token}`,
            '',
            'Your password doesn\'t change. If you didn\'t just try to sign in, don\'t open the link. Reset your password instead:',
            passwordRecoveryUrl
        ].join('\n')
    };
};

/** Sends an authentication email through SES without writing its token, code or address to logs. */
export const sendAuthEmail = async (recipient: string, email: AuthEmailTemplate) => {
    const sender = requireAuthEmailConfiguration();
    const { subject, text } = renderAuthEmail(email, email.template === 'resetCode' ? null : requireAuthLinkConfiguration());
    const client = new SESv2Client({ region: process.env.AWS_REGION });
    await client.send(new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [recipient] },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: { Text: { Data: text, Charset: 'UTF-8' } }
            }
        }
    }));
};
