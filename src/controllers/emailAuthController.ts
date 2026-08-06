import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { validationResult } from 'express-validator';
import AuthActionToken, { AuthActionPurpose } from '../models/authActionToken';
import AuthSession from '../models/authSession';
import User from '../models/user';
import { requireAuthEmailConfiguration, sendAuthCode } from '../services/authEmailService';
import { recordAuthFunnelEvent, recordSecurityEvent } from '../services/securityAuditService';

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();
const acceptedMessage = { message: 'If the account can use this action, an email has been sent.' };

const rejectInvalidRequest = (req: Request, res: Response) => {
    if (validationResult(req).isEmpty()) {
        return false;
    }
    res.status(422).json({ message: 'Please check the submitted fields.' });
    return true;
};

const issueCode = async (user: any, purpose: AuthActionPurpose) => {
    const lifetime = purpose === 'verifyEmail' ? 30 : 15;
    const code = await AuthActionToken.issue(user._id.toString(), purpose, lifetime);
    await sendAuthCode(user.email, purpose, code);
};

/** Finishes email requests uniformly so delivery failures cannot enumerate accounts. */
const acceptEmailRequest = async (
    res: Response,
    event: string,
    operation: () => Promise<void>
) => {
    // Configuration errors are deployment-wide and safe to report before any
    // account lookup. Per-account persistence/delivery failures remain opaque.
    requireAuthEmailConfiguration();
    try {
        await operation();
    } catch {
        recordSecurityEvent(event);
    }
    return res.status(202).json(acceptedMessage);
};

/** Creates an unverified email account and sends the same non-enumerating verification flow. */
export const registerEmailAccount = async (
    emailValue: unknown,
    passwordValue: unknown,
    displayNameValue: unknown,
    usernameValue: unknown = ''
) => {
    requireAuthEmailConfiguration();
    const email = normalizeEmail(emailValue);
    const password = String(passwordValue ?? '');
    const displayName = String(displayNameValue ?? '').trim().slice(0, 80);
    const username = String(usernameValue ?? '').trim().slice(0, 64);
    // Perform the same fixed-cost password work for new and existing emails.
    const passwordHash = await bcrypt.hash(password, 12);
    let user = await User.findByEmail(email);

    if (!user) {
        const result = await new User(
            email,
            passwordHash,
            username,
            [],
            'user',
            displayName,
            false
        ).save();
        user = await User.findById(result.insertedId.toString());
        recordSecurityEvent('email_registration_created', { userId: result.insertedId.toString() });
        recordAuthFunnelEvent('registration', 'email', 'succeeded');
    }

    if (user && user.emailVerified !== true) {
        await issueCode(user, 'verifyEmail');
    }
};

/** Registers an email account and sends a verification code without enumerating duplicates. */
export const register = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(
        res,
        'email_registration_request_failed',
        () => registerEmailAccount(req.body.email, req.body.password, req.body.displayName)
    );
};

/** Verifies ownership of an account email with a single-use code. */
export const verifyEmail = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const user = await User.findByEmail(normalizeEmail(req.body.email));
    const code = String(req.body.code ?? '').trim();
    if (!user || !await AuthActionToken.consume(user._id.toString(), 'verifyEmail', code)) {
        return res.status(400).json({ message: 'The verification code is invalid or expired.' });
    }
    await User.markEmailVerified(user._id.toString());
    recordSecurityEvent('email_verified', { userId: user._id.toString() });
    recordAuthFunnelEvent('verification', 'email', 'succeeded');
    return res.status(204).send();
};

/** Resends verification with the same response whether the account exists or not. */
export const resendVerification = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(res, 'verification_email_request_failed', async () => {
        const user = await User.findByEmail(normalizeEmail(req.body.email));
        if (user && user.emailVerified !== true) {
            await issueCode(user, 'verifyEmail');
        }
    });
};

/** Starts password recovery without revealing account existence. */
export const forgotPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    return acceptEmailRequest(res, 'password_recovery_request_failed', async () => {
        const user = await User.findByEmail(normalizeEmail(req.body.email));
        if (user) {
            await issueCode(user, 'resetPassword');
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
    if (!user || !await AuthActionToken.consume(user._id.toString(), 'resetPassword', code)) {
        return res.status(400).json({ message: 'The reset code is invalid or expired.' });
    }
    await User.updatePassword(user._id.toString(), passwordHash);
    await AuthSession.revokeAll(user._id.toString());
    recordSecurityEvent('password_reset_completed', { userId: user._id.toString() });
    recordAuthFunnelEvent('recovery', 'password', 'succeeded');
    return res.status(204).send();
};
