import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import AuthIdentity from '../models/authIdentity';
import User from '../models/user';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { createSession } from '../services/authSessionService';
import {
    VerifiedFederatedIdentity,
    verifyAppleIdentity,
    verifyGoogleIdentity
} from '../services/federatedIdentityService';
import { recordAuthFunnelEvent, recordSecurityEvent } from '../services/securityAuditService';
import { normalizeUserRole } from '../services/authRoleService';
import { withActiveAccount } from '../services/accountReferenceFenceService';
import {
    credentialTransactionOptions,
    replacePendingRecord,
    requireActiveAuthSession,
    requireVerifiedAccount
} from '../services/authCredentialService';
import { EmailVerificationRequiredError } from '../services/emailVerificationService';
import { notifyRoomChanges } from '../realtime/roomEvents';
import { respondEmailVerificationRequired } from './emailAuthController';

const conflict = () => {
    const error = new Error(
        'This email already has an account. Sign in with an existing method before linking this provider.'
    ) as Error & { statusCode?: number };
    error.statusCode = 409;
    return error;
};

const generatedUsername = (identity: VerifiedFederatedIdentity) =>
    `${identity.provider}_${crypto
        .createHash('sha256')
        .update(identity.subject)
        .digest('hex')
        .slice(0, 20)}`;

/** Resolves a verified provider identity without linking accounts by email alone. */
const resolveFederatedUser = async (
    req: AuthenticatedRequest,
    identity: VerifiedFederatedIdentity
) => {
    const linkedIdentity = await AuthIdentity.find(identity.provider, identity.subject);
    if (linkedIdentity) {
        if (req.auth && linkedIdentity.userId !== req.auth.userId) {
            throw conflict();
        }
        return User.findById(linkedIdentity.userId);
    }

    if (req.auth) {
        const authenticatedUser = await User.findById(req.auth.userId);
        if (!authenticatedUser) {
            const error = new Error('Authentication failed.') as Error & { statusCode?: number };
            error.statusCode = 401;
            throw error;
        }
        const auth = req.auth;
        await withActiveAccount(auth.userId, async session => {
            if (auth.sessionId) await requireActiveAuthSession(auth.userId, auth.sessionId, session);
            await requireVerifiedAccount(auth.userId, session);
            await AuthIdentity.create(
                auth.userId,
                identity.provider,
                identity.subject,
                identity.email,
                session
            );
        });
        recordSecurityEvent('federated_identity_linked', { userId: req.auth.userId });
        return authenticatedUser;
    }

    const existing = await User.findByEmail(identity.email);
    if (existing) {
        // An unverified record from the earlier code-based sign-up must not
        // block the inbox owner, who can no longer sign up by email in the
        // apps: the provider-verified email replaces it completely.
        if (existing.emailVerified !== false) throw conflict();
        return replacePendingRecordWithProvider(existing._id.toString(), identity);
    }

    const result = await new User(
        identity.email,
        '',
        generatedUsername(identity),
        [],
        'user',
        '',
        true
    ).save();
    const userId = result.insertedId.toString();
    try {
        await AuthIdentity.create(userId, identity.provider, identity.subject, identity.email);
    } catch (error) {
        // A failed identity insert must not strand the newly created account.
        await User.deleteById(userId);
        throw error;
    }
    recordSecurityEvent('federated_account_created', { userId });
    return User.findById(userId);
};

/**
 * Replaces an unverified record whose address the provider verified with a
 * provider-only account (no password, no name) and links the identity, in one
 * account-fenced transaction. A record that stopped being unverified
 * meanwhile keeps the existing-email conflict.
 */
const replacePendingRecordWithProvider = async (userId: string, identity: VerifiedFederatedIdentity) => {
    await withActiveAccount(userId, async session => {
        const replaced = await replacePendingRecord(
            userId,
            { password: '', displayName: '', username: generatedUsername(identity) },
            session
        );
        if (!replaced) throw conflict();
        await AuthIdentity.create(userId, identity.provider, identity.subject, identity.email, session);
    }, undefined, credentialTransactionOptions);
    notifyRoomChanges();
    recordSecurityEvent('federated_account_replaced_pending', { userId });
    return User.findById(userId);
};

/** Creates an app session only after authoritative provider verification succeeds. */
const completeFederatedAuthentication = async (
    req: Request,
    res: Response,
    identity: VerifiedFederatedIdentity
) => {
    const user = await resolveFederatedUser(req as AuthenticatedRequest, identity);
    if (!user) {
        return res.status(401).json({ message: 'Authentication failed.' });
    }
    let tokens: Awaited<ReturnType<typeof createSession>>;
    try {
        tokens = await createSession(user as any, req);
    } catch (error) {
        // A linked identity is a valid credential; an unverified account gets
        // the distinct 403 and its verification or registration link.
        if (error instanceof EmailVerificationRequiredError && error.account) {
            return respondEmailVerificationRequired(res, error.account, identity.provider);
        }
        throw error;
    }
    recordSecurityEvent('federated_login_succeeded', {
        userId: user._id.toString(),
        sessionId: tokens.sessionId
    });
    recordAuthFunnelEvent('login', identity.provider, 'succeeded');
    return res.status(200).json({
        ...tokens,
        userId: user._id.toString(),
        email: user.email,
        role: normalizeUserRole(user.role)
    });
};

export const authenticateWithApple = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const identity = await verifyAppleIdentity(
            String(req.body.identityToken ?? ''),
            String(req.body.nonce ?? '')
        );
        return await completeFederatedAuthentication(req, res, identity);
    } catch (error) {
        next(error);
    }
};

export const authenticateWithGoogle = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const identity = await verifyGoogleIdentity(
            String(req.body.identityToken ?? ''),
            String(req.body.nonce ?? '')
        );
        return await completeFederatedAuthentication(req, res, identity);
    } catch (error) {
        next(error);
    }
};
