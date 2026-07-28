import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { validationResult } from 'express-validator';
import AuthActionToken, { AuthActionPurpose } from '../models/authActionToken';
import AuthSession from '../models/authSession';
import User from '../models/user';
import { requireAuthEmailConfiguration, sendAuthCode } from '../services/authEmailService';
import { recordSecurityEvent } from '../services/securityAuditService';

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

/** Registers an email account and sends a verification code without enumerating duplicates. */
export const register = async (req: Request, res: Response, next: NextFunction) => {
    if (rejectInvalidRequest(req, res)) return;
    try {
        requireAuthEmailConfiguration();
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password ?? '');
        const displayName = String(req.body.displayName ?? '').trim().slice(0, 80);
        let user = await User.findByEmail(email);

        if (!user) {
            const passwordHash = await bcrypt.hash(password, 12);
            const result = await new User(email, passwordHash, '', [], 'user', displayName, false).save();
            user = await User.findById(result.insertedId.toString());
            recordSecurityEvent('email_registration_created', { userId: result.insertedId.toString() });
        }

        if (user && user.emailVerified !== true) {
            await issueCode(user, 'verifyEmail');
        }
        return res.status(202).json(acceptedMessage);
    } catch (error) {
        next(error);
    }
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
    return res.status(204).send();
};

/** Resends verification with the same response whether the account exists or not. */
export const resendVerification = async (req: Request, res: Response, next: NextFunction) => {
    if (rejectInvalidRequest(req, res)) return;
    try {
        const user = await User.findByEmail(normalizeEmail(req.body.email));
        if (user && user.emailVerified !== true) {
            await issueCode(user, 'verifyEmail');
        }
        return res.status(202).json(acceptedMessage);
    } catch (error) {
        next(error);
    }
};

/** Starts password recovery without revealing account existence. */
export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
    if (rejectInvalidRequest(req, res)) return;
    try {
        const user = await User.findByEmail(normalizeEmail(req.body.email));
        if (user) {
            await issueCode(user, 'resetPassword');
        }
        return res.status(202).json(acceptedMessage);
    } catch (error) {
        next(error);
    }
};

/** Replaces a password after consuming a reset code and revokes every active session. */
export const resetPassword = async (req: Request, res: Response) => {
    if (rejectInvalidRequest(req, res)) return;
    const user = await User.findByEmail(normalizeEmail(req.body.email));
    const code = String(req.body.code ?? '').trim();
    if (!user || !await AuthActionToken.consume(user._id.toString(), 'resetPassword', code)) {
        return res.status(400).json({ message: 'The reset code is invalid or expired.' });
    }
    await User.updatePassword(user._id.toString(), await bcrypt.hash(String(req.body.password), 12));
    await AuthSession.revokeAll(user._id.toString());
    recordSecurityEvent('password_reset_completed', { userId: user._id.toString() });
    return res.status(204).send();
};
