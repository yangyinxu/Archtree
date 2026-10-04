import crypto from 'crypto';
import { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { withActiveAccount } from '../services/accountReferenceFenceService';

/** Six-digit codes now exist only for password reset; registration and verification use email links. */
export type AuthActionPurpose = 'resetPassword';

/** A code's fifth wrong submission voids it; the user must then request a new code. */
export const maxFailedCodeAttempts = 5;

interface AuthActionTokenDocument {
    _id: string;
    userId: string;
    purpose: AuthActionPurpose;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt?: Date;
    /** Set when wrong attempts voided the code. */
    voidedAt?: Date;
    failedAttempts?: number;
}

/** Gives each account and purpose one current-code slot, so issuing a code voids every earlier one. */
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

const tokens = () => getDb()!.collection<AuthActionTokenDocument>('authActionTokens');

/** Stores short-lived, single-use password-reset codes only as hashes. */
class AuthActionToken {
    /** Issues a password-reset code, replacing the account's earlier code. */
    static async issue(userId: string, purpose: AuthActionPurpose, lifetimeMinutes: number, session?: ClientSession) {
        const code = crypto.randomInt(100_000, 1_000_000).toString();
        await withActiveAccount(userId, transaction => this.writeSlot(userId, purpose, code, lifetimeMinutes, transaction), session);
        return code;
    }

    /** Replaces the account's slot for a purpose, resetting its expiry and wrong-attempt count. */
    private static writeSlot(
        userId: string,
        purpose: AuthActionPurpose,
        code: string,
        lifetimeMinutes: number,
        session: ClientSession
    ) {
        const now = new Date();
        return tokens().replaceOne(
            { _id: tokenDocumentId(userId, purpose) },
            {
                userId,
                purpose,
                codeHash: hashCode(userId, purpose, code),
                createdAt: now,
                expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000),
                failedAttempts: 0
            },
            { upsert: true, session }
        );
    }

    /**
     * Atomically consumes a matching live code so concurrent reuse can succeed
     * only once, and returns the consumed slot. A wrong code counts against the
     * live slot; the attempt that reaches `maxFailedCodeAttempts` voids it in
     * the same transaction.
     */
    static consume(userId: string, purpose: AuthActionPurpose, code: string, session?: ClientSession) {
        return withActiveAccount(userId, transaction => this.consumeInTransaction(userId, purpose, code, transaction), session);
    }

    private static async consumeInTransaction(userId: string, purpose: AuthActionPurpose, code: string, session: ClientSession) {
        const slotId = tokenDocumentId(userId, purpose);
        const now = new Date();
        const live = { _id: slotId, consumedAt: { $exists: false }, expiresAt: { $gt: now } };
        const matched = await tokens().findOneAndUpdate(
            { ...live, userId, purpose, codeHash: hashCode(userId, purpose, code) },
            { $set: { consumedAt: now } },
            { returnDocument: 'before', session }
        );
        if (matched.value) return matched.value;

        const counted = await tokens().findOneAndUpdate(
            live,
            { $inc: { failedAttempts: 1 } },
            { returnDocument: 'after', session }
        );
        if ((counted.value?.failedAttempts ?? 0) >= maxFailedCodeAttempts) await this.voidSlot(slotId, now, session);
        return null;
    }

    private static voidSlot(slotId: string, now: Date, session: ClientSession) {
        return tokens().updateOne(
            { _id: slotId, consumedAt: { $exists: false } },
            { $set: { consumedAt: now, voidedAt: now } },
            { session }
        );
    }

    /**
     * Removes every code slot of an account, including verification slots left
     * by the earlier code-based sign-up, when the record is replaced.
     */
    static deleteForUser(userId: string, session: ClientSession) {
        return getDb()!.collection('authActionTokens').deleteMany({ userId }, { session });
    }
}

export default AuthActionToken;
