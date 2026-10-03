import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { revokeSessionsInTransaction, revokeSessionsWithRoomCleanup } from '../services/sessionRoomLifecycleService';
import { withActiveAccount } from '../services/accountReferenceFenceService';

export interface AuthSessionDocument {
    _id: ObjectId;
    userId: string;
    refreshTokenHash: string;
    previousRefreshTokenHash?: string;
    /** When `previousRefreshTokenHash` was rotated out; anchors its lost-response replay window. */
    rotatedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    revokedAt?: Date;
    userAgent?: string;
    deviceName?: string;
    deviceType?: 'phone' | 'tablet';
}

/** Persists revocable refresh sessions without storing usable refresh tokens. */
class AuthSession {
    static async create(
        userId: string,
        refreshTokenHash: string,
        expiresAt: Date,
        userAgent?: string,
        device?: { deviceName: string; deviceType: 'phone' | 'tablet' },
        session?: ClientSession
    ) {
        const db = getDb();
        const now = new Date();
        const result = await withActiveAccount(userId, transaction => db!.collection<AuthSessionDocument>('authSessions').insertOne({
            _id: new ObjectId(),
            userId,
            refreshTokenHash,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            ...(userAgent ? { userAgent } : {}),
            ...(device ?? {})
        }, { session: transaction }), session);

        return result.insertedId.toString();
    }

    /**
     * Rotates the current refresh token atomically, so concurrent presentations
     * of one current token can rotate it only once. The replaced hash becomes
     * the session's only previous token and starts its replay window.
     */
    static async rotate(refreshTokenHash: string, replacementHash: string, now = new Date()) {
        const db = getDb();
        const result = await db!.collection<AuthSessionDocument>('authSessions').findOneAndUpdate(
            {
                refreshTokenHash,
                revokedAt: { $exists: false },
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    previousRefreshTokenHash: refreshTokenHash,
                    refreshTokenHash: replacementHash,
                    rotatedAt: now,
                    updatedAt: now
                }
            },
            { returnDocument: 'after' }
        );
        return result.value;
    }

    /**
     * Re-runs the latest rotation for a client whose rotation response was lost
     * and that presents the immediately previous token again. Only the current
     * hash is replaced, so the pair issued by the lost response stops working
     * and the session still has exactly one current token. The previous hash
     * and `rotatedAt` stay unchanged: a replay can never extend its own window,
     * and a normal rotation of the current token ends it immediately.
     */
    static async rotateFromPrevious(
        previousRefreshTokenHash: string,
        replacementHash: string,
        rotatedAfter: Date,
        now = new Date()
    ) {
        const db = getDb();
        const result = await db!.collection<AuthSessionDocument>('authSessions').findOneAndUpdate(
            {
                previousRefreshTokenHash,
                rotatedAt: { $gt: rotatedAfter },
                revokedAt: { $exists: false },
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    refreshTokenHash: replacementHash,
                    updatedAt: now
                }
            },
            { returnDocument: 'after' }
        );
        return result.value;
    }

    /** Returns an active session used to enforce access-token revocation. */
    static async findActiveById(sessionId: string, session?: ClientSession) {
        if (!ObjectId.isValid(sessionId)) {
            return null;
        }

        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').findOne({
            _id: new ObjectId(sessionId),
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() }
        }, { session });
    }

    /** Resolves an opaque refresh credential without rotating or exposing its hash. */
    static async findActiveByRefreshTokenHash(refreshTokenHash: string) {
        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').findOne({
            $or: [
                { refreshTokenHash },
                { previousRefreshTokenHash: refreshTokenHash }
            ],
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() }
        });
    }

    static async revokeByRefreshTokenHash(refreshTokenHash: string) {
        return revokeSessionsWithRoomCleanup({
            $or: [{ refreshTokenHash }, { previousRefreshTokenHash: refreshTokenHash }],
            revokedAt: { $exists: false }
        }, 'session');
    }

    static async revokeById(userId: string, sessionId: string) {
        if (!ObjectId.isValid(sessionId)) return null;
        return revokeSessionsWithRoomCleanup({ _id: new ObjectId(sessionId), userId,
            revokedAt: { $exists: false } }, 'session', userId);
    }

    static async revokeAll(userId: string, session?: ClientSession) {
        if (session) return revokeSessionsInTransaction({ userId, revokedAt: { $exists: false } }, 'logoutAll', session, userId);
        return revokeSessionsWithRoomCleanup({ userId, revokedAt: { $exists: false } }, 'logoutAll', userId);
    }

    /** A credential change preserves the current session and its room controller. */
    static async revokeAllExcept(userId: string, sessionId: string, session?: ClientSession) {
        if (!ObjectId.isValid(sessionId)) return null;
        if (session) return revokeSessionsInTransaction({ userId, _id: { $ne: new ObjectId(sessionId) },
            revokedAt: { $exists: false } }, 'otherSessions', session, userId, sessionId);
        return revokeSessionsWithRoomCleanup({ userId, _id: { $ne: new ObjectId(sessionId) },
            revokedAt: { $exists: false } }, 'otherSessions', userId, sessionId);
    }

    /** Lists active sessions without ever exposing refresh-token hashes. */
    static listActive(userId: string) {
        return getDb()!.collection<AuthSessionDocument>('authSessions')
            .find({
                userId,
                revokedAt: { $exists: false },
                expiresAt: { $gt: new Date() }
            })
            .project({
                refreshTokenHash: 0,
                previousRefreshTokenHash: 0
            })
            .sort({ updatedAt: -1 })
            .limit(50)
            .toArray();
    }

    /** Removes revoked session metadata after final account deletion. */
    static deleteForUser(userId: string) {
        return getDb()!.collection<AuthSessionDocument>('authSessions').deleteMany({ userId });
    }
}

export default AuthSession;
