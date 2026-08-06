import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

export type AuthActionPurpose = 'verifyEmail' | 'resetPassword';

interface AuthActionTokenDocument {
    _id: ObjectId | string;
    userId: string;
    purpose: AuthActionPurpose;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt?: Date;
}

/** Gives each account and purpose one current-code slot while legacy tokens age out. */
const tokenDocumentId = (userId: string, purpose: AuthActionPurpose) => crypto
    .createHash('sha256')
    .update(`${userId}\0${purpose}`, 'utf8')
    .digest('hex');

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
        await db!.collection<AuthActionTokenDocument>('authActionTokens').findOneAndUpdate(
            { _id: tokenDocumentId(userId, purpose) },
            {
                $set: {
                    userId,
                    purpose,
                    codeHash: hashCode(userId, purpose, code),
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000)
                },
                $unset: { consumedAt: '' }
            },
            { upsert: true, returnDocument: 'after' }
        );
        return code;
    }

    /** Atomically consumes a matching code so concurrent reuse can succeed only once. */
    static async consume(userId: string, purpose: AuthActionPurpose, code: string) {
        const db = getDb();
        const collection = db!.collection<AuthActionTokenDocument>('authActionTokens');
        const currentDocumentId = tokenDocumentId(userId, purpose);
        const now = new Date();
        const submittedCodeHash = hashCode(userId, purpose, code);
        const result = await collection.findOneAndUpdate(
            {
                _id: currentDocumentId,
                userId,
                purpose,
                codeHash: submittedCodeHash,
                consumedAt: { $exists: false },
                expiresAt: { $gt: now }
            },
            { $set: { consumedAt: now } },
            { returnDocument: 'after' }
        );
        if (result.value) return result.value;

        // A current slot invalidates every earlier code, including documents
        // written before deterministic per-purpose slots were introduced.
        const currentSlot = await collection.findOne(
            { _id: currentDocumentId },
            { projection: { _id: 1 } }
        );
        if (currentSlot) return null;

        // Preserve one already-delivered legacy code until this account and purpose
        // first uses the current single-slot representation.
        const legacyToken = await collection.findOne(
            {
                _id: { $type: 'objectId' },
                userId,
                purpose,
                codeHash: submittedCodeHash,
                consumedAt: { $exists: false },
                expiresAt: { $gt: now }
            },
            { projection: { _id: 1, userId: 1, purpose: 1, codeHash: 1, createdAt: 1, expiresAt: 1 } }
        );
        if (!legacyToken) return null;

        // Claim the deterministic slot before accepting a legacy token. This also
        // makes distinct legacy codes single-use when an earlier release created
        // more than one active document concurrently. Existing legacy lifetimes
        // are at most 30 minutes, so the one-hour fence outlives every such code.
        const legacyClaim = await collection.findOneAndUpdate(
            { _id: currentDocumentId },
            {
                $setOnInsert: {
                    userId,
                    purpose,
                    codeHash: submittedCodeHash,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + 60 * 60_000),
                    consumedAt: now
                }
            },
            { upsert: true, returnDocument: 'before' }
        );
        return legacyClaim.value ? null : legacyToken;
    }
}

export default AuthActionToken;
