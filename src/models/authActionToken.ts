import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

export type AuthActionPurpose = 'verifyEmail' | 'resetPassword';

interface AuthActionTokenDocument {
    _id: ObjectId;
    userId: string;
    purpose: AuthActionPurpose;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt?: Date;
}

const hashCode = (userId: string, purpose: AuthActionPurpose, code: string) => {
    const pepper = process.env.AUTH_CODE_PEPPER ?? process.env.JWT_SECRET;
    if (!pepper) {
        throw new Error('Authentication code pepper is not configured.');
    }
    return crypto
        .createHmac('sha256', pepper)
        .update(`${userId}:${purpose}:${code}`, 'utf8')
        .digest('hex');
};

/** Stores short-lived, single-use authentication codes only as hashes. */
class AuthActionToken {
    static async issue(userId: string, purpose: AuthActionPurpose, lifetimeMinutes: number) {
        const db = getDb();
        const code = crypto.randomInt(100_000, 1_000_000).toString();
        const now = new Date();
        await db!.collection<AuthActionTokenDocument>('authActionTokens').updateMany(
            { userId, purpose, consumedAt: { $exists: false } },
            { $set: { consumedAt: now } }
        );
        await db!.collection<AuthActionTokenDocument>('authActionTokens').insertOne({
            _id: new ObjectId(),
            userId,
            purpose,
            codeHash: hashCode(userId, purpose, code),
            createdAt: now,
            expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000)
        });
        return code;
    }

    /** Atomically consumes a matching code so concurrent reuse can succeed only once. */
    static async consume(userId: string, purpose: AuthActionPurpose, code: string) {
        const db = getDb();
        const result = await db!.collection<AuthActionTokenDocument>('authActionTokens').findOneAndUpdate(
            {
                userId,
                purpose,
                codeHash: hashCode(userId, purpose, code),
                consumedAt: { $exists: false },
                expiresAt: { $gt: new Date() }
            },
            { $set: { consumedAt: new Date() } },
            { returnDocument: 'after' }
        );
        return result.value;
    }
}

export default AuthActionToken;
