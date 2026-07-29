import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import AuthSession from '../models/authSession';
import { recordSecurityEvent } from '../services/securityAuditService';

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
