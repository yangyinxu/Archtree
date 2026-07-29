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
import { recordSecurityEvent } from '../services/securityAuditService';

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
        await AuthIdentity.create(
            req.auth.userId,
            identity.provider,
            identity.subject,
            identity.email
        );
        recordSecurityEvent('federated_identity_linked', { userId: req.auth.userId });
        return authenticatedUser;
    }

    if (await User.findByEmail(identity.email)) {
        throw conflict();
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
    const tokens = await createSession(user as any, req);
    recordSecurityEvent('federated_login_succeeded', {
        userId: user._id.toString(),
        sessionId: tokens.sessionId
    });
    return res.status(200).json({
        ...tokens,
        userId: user._id.toString(),
        email: user.email,
        role: user.role ?? 'user'
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
