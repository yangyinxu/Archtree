import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { validationResult } from 'express-validator';
import { MongoServerError } from 'mongodb';
import { releaseConcurrencySlots } from '../middleware/requestProtectionMiddleware';
import AuthActionToken, { PendingRegistration } from '../models/authActionToken';
import User from '../models/user';
import { requireAuthEmailConfiguration, sendAuthCode } from '../services/authEmailService';
import { recordAuthFunnelEvent, recordSecurityEvent } from '../services/securityAuditService';
import { applyEmailAction } from '../services/authCredentialService';
import { queueVerificationDelivery, queueVerificationResend } from '../services/verificationDeliveryQueue';

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();
const acceptedMessage = { message: 'If the account can use this action, an email has been sent.' };

const rejectInvalidRequest = (req: Request, res: Response) => {
    if (validationResult(req).isEmpty()) {
        return false;
    }
    res.status(422).json({ message: 'Please check the submitted fields.' });
    return true;
};

/**
 * Sends a verification code bound to `attempt`, or for a resend to the
 * unverified account's stored credentials. Resolves false without sending when
 * the account is not unverified.
 */
const sendVerificationCode = async (user: any, attempt?: PendingRegistration) => {
    const code = await AuthActionToken.issueVerification(user._id.toString(), attempt);
    if (!code) return false;
    await sendAuthCode(user.email, 'verifyEmail', code);
    return true;
};

/**
 * Sends a generic response before running per-account email work.
 *
 * The lookup, token write, password hash, and SES send take measurably longer
 * for some account states, so awaiting them first would let response latency
 * reveal whether an email has an account. The work stays inside the caller's
 * handler promise (never detached), so `asyncHandler` keeps tracking it:
 * graceful shutdown waits for it to finish, and so do concurrency limits
 * unless the handler releases its slot early (registration does). Failures
 * are recorded only as an opaque security event, because the response has
 * already been sent. `operation` starts in the same synchronous turn as the
 * response, before the server can handle the client's next request;
 * registration relies on this to queue its attempt ahead of a quick resend.
 */
export const respondBeforeAccountWork = async (
    respond: () => void,
    event: string,
    operation: () => Promise<void>
) => {
    respond();
    try {
        await operation();
    } catch {
        recordSecurityEvent(event);
    }
};

/** Finishes email requests uniformly so neither latency nor delivery failures enumerate accounts. */
const acceptEmailRequest = async (
    res: Response,
    event: string,
    operation: () => Promise<void>
) => {
    // Configuration errors are deployment-wide and safe to report before any
    // account lookup. Per-account persistence/delivery failures remain opaque.
    requireAuthEmailConfiguration();
    await respondBeforeAccountWork(() => res.status(202).json(acceptedMessage), event, operation);
};

/** Creates the unverified account for a first attempt, or returns the account another process just created. */
const createUnverifiedAccount = async (email: string, attempt: PendingRegistration) => {
    try {
        const result = await new User(
            email,
            attempt.passwordHash,
            attempt.username,
            [],
            'user',
            attempt.displayName,
            false
        ).save();
        recordSecurityEvent('email_registration_created', { userId: result.insertedId.toString() });
        recordAuthFunnelEvent('registration', 'email', 'succeeded');
        return User.findById(result.insertedId.toString());
    } catch (error) {
        // The unique email index rejected a concurrent first attempt; this
        // attempt is newer and binds its credentials to the existing account.
        if (error instanceof MongoServerError && error.code === 11000) return User.findByEmail(email);
        throw error;
    }
};

/**
 * Applies one registration attempt. An email without a verified account gets
 * a new code bound to this attempt's credentials, which voids every earlier
 * code; a verified account, including a legacy one without the field, is left
 * unchanged. Resolves whether a code was sent.
 */
const recordRegistrationAttempt = async (email: string, attempt: PendingRegistration) => {
    const user = await User.findByEmail(email) ?? await createUnverifiedAccount(email, attempt);
    if (!user || user.emailVerified !== false) return false;
    return sendVerificationCode(user, attempt);
};

/**
 * Starts the password hash and, without awaiting it, queues the attempt on
 * the address's verification queue; the account-dependent work runs in its
 * turn once the hash is ready. Callers send the generic response first and
 * must call this in the same synchronous turn (`respondBeforeAccountWork`
 * does), so the attempt is queued before any later request for the address
 * can be handled. `afterPasswordHash` releases their concurrency slot once
 * hashing settles.
 */
export const registerEmailAccount = async (
    emailValue: unknown,
    passwordValue: unknown,
    displayNameValue: unknown,
    usernameValue: unknown = '',
    afterPasswordHash: () => void = () => undefined
) => {
    requireAuthEmailConfiguration();
    const email = normalizeEmail(emailValue);
    const password = String(passwordValue ?? '');
    const displayName = String(displayNameValue ?? '').trim().slice(0, 80);
    const username = String(usernameValue ?? '').trim().slice(0, 64);
    // Perform the same fixed-cost password work for new and existing emails.
    const passwordHash = bcrypt.hash(password, 12);
    // Hashing is the work the concurrency slot bounds, and it costs the same
    // for every account state. Releasing the slot when it settles keeps how
    // long it is held, and so any 429 it causes, independent of whether the
    // email has an account, and of earlier work queued for the address.
    // Graceful shutdown still waits for the remaining work.
    void passwordHash.then(afterPasswordHash, afterPasswordHash);
    // Queue before the hash settles: a resend sent as soon as the response
    // arrives then finds this attempt in flight and waits for its email,
    // instead of finding no account yet and being dropped.
    await queueVerificationDelivery(email, async () => recordRegistrationAttempt(email, {
        passwordHash: await passwordHash,
        displayName,
        username
    }));
};

/** Registers an email account and sends a verification code without enumerating duplicates. */
export const register = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(
        res,
        'email_registration_request_failed',
        () => registerEmailAccount(
            req.body.email,
            req.body.password,
            req.body.displayName,
            '',
            () => releaseConcurrencySlots(req)
        )
    );
};

/**
 * Verifies email ownership with a single-use code and applies exactly the
 * registration attempt bound to it; wrong codes count toward voiding it.
 */
export const verifyEmail = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const user = await User.findByEmail(normalizeEmail(req.body.email));
    const code = String(req.body.code ?? '').trim();
    if (!user || !await applyEmailAction(user._id.toString(), 'verifyEmail', code)) {
        return res.status(400).json({ message: 'The verification code is invalid or expired.' });
    }
    recordSecurityEvent('email_verified', { userId: user._id.toString() });
    recordAuthFunnelEvent('verification', 'email', 'succeeded');
    return res.status(204).send();
};

/**
 * Resends verification with the same response whether the account exists or
 * not. The new code is bound to the newest registration attempt (or a later
 * reset password); a resend pressed while an earlier verification email for
 * the address is still in flight reuses that delivery when it succeeds.
 */
export const resendVerification = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const email = normalizeEmail(req.body.email);
    return acceptEmailRequest(res, 'verification_email_request_failed', async () => {
        await queueVerificationResend(email, async () => {
            const user = await User.findByEmail(email);
            return user?.emailVerified === false ? sendVerificationCode(user) : false;
        });
    });
};

/** Starts password recovery without revealing account existence. */
export const forgotPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(res, 'password_recovery_request_failed', async () => {
        const user = await User.findByEmail(normalizeEmail(req.body.email));
        if (user) {
            const code = await AuthActionToken.issue(user._id.toString(), 'resetPassword', 15);
            await sendAuthCode(user.email, 'resetPassword', code);
        }
    });
};

/** Replaces a password after consuming a reset code and revokes every active session. */
export const resetPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    // Hash before account/code resolution to keep invalid attempts on the same
    // expensive path and avoid consuming a valid code if hashing fails.
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const user = await User.findByEmail(normalizeEmail(req.body.email));
    const code = String(req.body.code ?? '').trim();
    if (!user || !await applyEmailAction(user._id.toString(), 'resetPassword', code, passwordHash)) {
        return res.status(400).json({ message: 'The reset code is invalid or expired.' });
    }
    recordSecurityEvent('password_reset_completed', { userId: user._id.toString() });
    recordAuthFunnelEvent('recovery', 'password', 'succeeded');
    return res.status(204).send();
};
