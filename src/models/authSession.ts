import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

export interface AuthSessionDocument {
    _id: ObjectId;
    userId: string;
    refreshTokenHash: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    revokedAt?: Date;
    userAgent?: string;
}

/** Persists revocable refresh sessions without storing usable refresh tokens. */
class AuthSession {
    static async create(userId: string, refreshTokenHash: string, expiresAt: Date, userAgent?: string) {
        const db = getDb();
        const now = new Date();
        const result = await db!.collection<AuthSessionDocument>('authSessions').insertOne({
            _id: new ObjectId(),
            userId,
            refreshTokenHash,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            ...(userAgent ? { userAgent } : {})
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

    static async revokeByRefreshTokenHash(refreshTokenHash: string) {
        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').updateOne(
            {
                refreshTokenHash,
                revokedAt: { $exists: false }
            },
            {
                $set: {
                    revokedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );
    }

    static async revokeById(userId: string, sessionId: string) {
        if (!ObjectId.isValid(sessionId)) {
            return null;
        }

        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').updateOne(
            {
                _id: new ObjectId(sessionId),
                userId,
                revokedAt: { $exists: false }
            },
            {
                $set: {
                    revokedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );
    }

    static async revokeAll(userId: string) {
        const db = getDb();
        return db!.collection<AuthSessionDocument>('authSessions').updateMany(
            {
                userId,
                revokedAt: { $exists: false }
            },
            {
                $set: {
                    revokedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );
    }

    /** Revokes every other device while preserving the session that changed credentials. */
    static async revokeAllExcept(userId: string, sessionId: string) {
        if (!ObjectId.isValid(sessionId)) {
            return null;
        }
        const now = new Date();
        return getDb()!.collection<AuthSessionDocument>('authSessions').updateMany(
            {
                userId,
                _id: { $ne: new ObjectId(sessionId) },
                revokedAt: { $exists: false }
            },
            {
                $set: {
                    revokedAt: now,
                    updatedAt: now
                }
            }
        );
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
                refreshTokenHash: 0
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
