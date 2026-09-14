import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { revokeSessionsWithRoomCleanup } from '../services/sessionRoomLifecycleService';

export interface AuthSessionDocument {
    _id: ObjectId;
    userId: string;
    refreshTokenHash: string;
    previousRefreshTokenHash?: string;
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
        device?: { deviceName: string; deviceType: 'phone' | 'tablet' }
    ) {
        const db = getDb();
        const now = new Date();
        const result = await db!.collection<AuthSessionDocument>('authSessions').insertOne({
            _id: new ObjectId(),
            userId,
            refreshTokenHash,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            ...(userAgent ? { userAgent } : {}),
            ...(device ?? {})
        });

        return result.insertedId.toString();
    }

    /** Rotates a refresh token atomically so concurrent reuse can only succeed once. */
    static async rotate(refreshTokenHash: string, replacementHash: string) {
        const db = getDb();
        const result = await db!.collection<AuthSessionDocument>('authSessions').findOneAndUpdate(
            {
                refreshTokenHash,
                revokedAt: { $exists: false },
                expiresAt: { $gt: new Date() }
            },
            {
                $set: {
                    previousRefreshTokenHash: refreshTokenHash,
                    refreshTokenHash: replacementHash,
                    updatedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );
        return result.value;
    }

    /** Returns an active session used to enforce access-token revocation. */
    static async findActiveById(sessionId: string) {
        if (!ObjectId.isValid(sessionId)) {
            return null;
        }

        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').findOne({
            _id: new ObjectId(sessionId),
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() }
        });
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

    static async revokeAll(userId: string) {
        return revokeSessionsWithRoomCleanup({ userId, revokedAt: { $exists: false } }, 'logoutAll', userId);
    }

    /** A credential change preserves the current session and its room controller. */
    static async revokeAllExcept(userId: string, sessionId: string) {
        if (!ObjectId.isValid(sessionId)) return null;
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
