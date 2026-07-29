import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import AuthSession from '../models/authSession';
import AuthIdentity, { AuthProvider } from '../models/authIdentity';
import { Passkey } from '../models/passkey';
import User from '../models/user';
import { recordSecurityEvent } from '../services/securityAuditService';
import { evaluatePassword } from '../services/passwordPolicyService';

const creatorCollections = ['artists', 'albums', 'audioTracks', 'carousels', 'pages', 'imageAssets'];

/** Lists revocable devices while marking the access token's own session. */
export const listSessions = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const sessions = await AuthSession.listActive(auth.userId);
    return res.status(200).json({
        sessions: sessions.map(session => ({
            id: session._id.toString(),
            createdAt: session.createdAt,
            lastUsedAt: session.updatedAt,
            expiresAt: session.expiresAt,
            userAgent: session.userAgent ?? 'Unknown device',
            isCurrent: session._id.toString() === auth.sessionId
        }))
    });
};

/** Revokes one session only when it belongs to the authenticated account. */
export const revokeSession = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    await AuthSession.revokeById(auth.userId, String(req.params.id ?? ''));
    recordSecurityEvent('session_revoked', { userId: auth.userId });
    return res.status(204).send();
};

/** Sets or changes a password and signs out every other active device. */
export const changePassword = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    if (!auth.sessionId) {
        return res.status(409).json({
            message: 'Sign in again with the current app before changing your password.'
        });
    }

    const user = await User.findById(auth.userId);
    if (!user) {
        return res.status(404).json({ message: 'The account could not be found.' });
    }

    const currentPassword = String(req.body.currentPassword ?? '');
    const newPassword = String(req.body.newPassword ?? '');
    const passwordPolicy = evaluatePassword(newPassword);
    if (!passwordPolicy.accepted) {
        return res.status(400).json({ message: passwordPolicy.message });
    }
    if (user.password) {
        const matches = currentPassword.length <= 256
            && await bcrypt.compare(currentPassword, user.password);
        if (!matches) {
            recordSecurityEvent('password_change_rejected', { userId: auth.userId });
            return res.status(400).json({ message: 'The current password is incorrect.' });
        }
        if (await bcrypt.compare(newPassword, user.password)) {
            return res.status(400).json({ message: 'Choose a password you have not already used.' });
        }
    }

    await User.updatePassword(auth.userId, await bcrypt.hash(newPassword, 12));
    await AuthSession.revokeAllExcept(auth.userId, auth.sessionId);
    recordSecurityEvent('password_changed', {
        userId: auth.userId,
        sessionId: auth.sessionId
    });
    return res.status(204).send();
};

/** Clears listening activity while preserving the user's saved Library. */
export const clearListeningHistory = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    await getDb()!.collection('userActivity').updateOne(
        { userId: auth.userId },
        { $set: { recentlyPlayed: [], updatedAt: new Date() } }
    );
    recordSecurityEvent('listening_history_cleared', { userId: auth.userId });
    return res.status(204).send();
};

/** Unlinks a provider only when another usable authentication method remains. */
export const unlinkProvider = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const provider = String(req.params.provider ?? '') as AuthProvider;
    if (provider !== 'apple' && provider !== 'google') {
        return res.status(400).json({ message: 'The sign-in provider is not supported.' });
    }

    const [user, identities, passkeys] = await Promise.all([
        User.findById(auth.userId),
        AuthIdentity.listForUser(auth.userId),
        Passkey.listForUser(auth.userId)
    ]);
    const methodCount = (user?.password ? 1 : 0) + identities.length + (passkeys.length ? 1 : 0);
    if (methodCount <= 1) {
        return res.status(409).json({
            message: 'Add another sign-in method before removing your only recovery option.'
        });
    }

    await AuthIdentity.deleteForUserAndProvider(auth.userId, provider);
    recordSecurityEvent('provider_unlinked', { userId: auth.userId });
    return res.status(204).send();
};

/** Deletes listener data atomically enough to retry, while creator accounts fail closed. */
export const deleteAccount = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const db = getDb()!;
    for (const collection of creatorCollections) {
        if (await db.collection(collection).findOne({ createdBy: auth.userId }, { projection: { _id: 1 } })) {
            return res.status(409).json({
                message: 'Creator-owned content must be transferred or deleted before this account can be removed.'
            });
        }
    }

    const databaseSession = getDatabaseClient().startSession();
    try {
        await databaseSession.withTransaction(async () => {
            const options = { session: databaseSession };
            await db.collection('userSaves').deleteMany({ userId: auth.userId }, options);
            await db.collection('userActivity').deleteMany({ userId: auth.userId }, options);
            await db.collection('authActionTokens').deleteMany({ userId: auth.userId }, options);
            await db.collection('authIdentities').deleteMany({ userId: auth.userId }, options);
            await db.collection('passkeys').deleteMany({ userId: auth.userId }, options);
            await db.collection('passkeyChallenges').deleteMany({ userId: auth.userId }, options);
            await db.collection('authSessions').deleteMany({ userId: auth.userId }, options);
            await db.collection('users').deleteOne(
                { _id: new ObjectId(auth.userId) },
                options
            );
        });
    } finally {
        await databaseSession.endSession();
    }
    recordSecurityEvent('account_deleted', { userId: auth.userId });
    return res.status(204).send();
};
