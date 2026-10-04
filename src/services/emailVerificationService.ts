import { ClientSession } from 'mongodb';
import AuthIdentity from '../models/authIdentity';

/**
 * How an account's stored `emailVerified` value is read:
 * - `verified`: `true`, or a legacy account with a linked Apple/Google
 *   identity that carries the account's own email (provider-verified).
 * - `pending_record`: `false`, left by the earlier code-based sign-up. Such a
 *   record is unusable and is replaced when the inbox owner registers.
 * - `legacy_unverified`: the field is absent (created before verification
 *   existed) and no linked identity proves the email.
 */
export type EmailVerificationState = 'verified' | 'pending_record' | 'legacy_unverified';

export interface EmailVerificationSubject {
    _id: { toString(): string };
    email?: unknown;
    emailVerified?: unknown;
}

/**
 * The single source of truth for whether an account may sign in or add a
 * sign-in method. It never writes: a legacy account verified only through a
 * linked identity becomes unverified again when that identity is unlinked.
 * Pass the credential transaction's `session` so the read serializes with it.
 */
export const emailVerificationState = async (
    user: EmailVerificationSubject,
    session?: ClientSession
): Promise<EmailVerificationState> => {
    if (user.emailVerified === true) return 'verified';
    if (user.emailVerified === false) return 'pending_record';
    const email = String(user.email ?? '').trim().toLowerCase();
    if (email && await AuthIdentity.hasEmailForUser(user._id.toString(), email, session)) return 'verified';
    return 'legacy_unverified';
};

/** Message a sign-in receives when a valid credential belongs to an unverified account. */
export const signInVerificationRequiredMessage =
    'Verify your email to sign in. Open the verification link we sent to your email address, then sign in again.';

/** Message an unverified account receives when it tries to link a provider or enroll a passkey. */
export const addMethodVerificationRequiredMessage = 'Verify your email before adding a sign-in method.';

/**
 * A distinct `403` that clients map to "open the verification link". `account`
 * is set only for sign-in attempts that presented a valid credential, which
 * are the ones that trigger a verification email.
 */
export class EmailVerificationRequiredError extends Error {
    readonly statusCode = 403;
    readonly code = 'email_verification_required';
    /** Lets the application error handler include `code` in the JSON body. */
    readonly exposeCode = true;

    constructor(
        readonly account?: EmailVerificationSubject,
        message = signInVerificationRequiredMessage
    ) {
        super(message);
    }
}
