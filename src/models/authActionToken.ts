import crypto from 'crypto';
import { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { withActiveAccount } from '../services/accountReferenceFenceService';
import User from './user';

export type AuthActionPurpose = 'verifyEmail' | 'resetPassword';

/**
 * Credentials captured from one registration attempt. A verification code is
 * bound to exactly one of these, and redeeming the code applies exactly them.
 */
export interface PendingRegistration {
    passwordHash: string;
    displayName: string;
    username: string;
}

/** A code's fifth wrong submission voids it; the user must then request a new code. */
export const maxFailedCodeAttempts = 5;
const verificationLifetimeMinutes = 30;

interface AuthActionTokenDocument {
    _id: string;
    userId: string;
    purpose: AuthActionPurpose;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt?: Date;
    /** Set when wrong attempts or a superseding credential change voided the code. */
    voidedAt?: Date;
    failedAttempts?: number;
    /** Present only on unredeemed verification codes; removed once the code is consumed or voided. */
    registration?: PendingRegistration;
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

/** Stores short-lived, single-use authentication codes only as hashes. */
class AuthActionToken {
    /** Issues a password-reset code; verification codes must carry credentials through `issueVerification`. */
    static async issue(userId: string, purpose: 'resetPassword', lifetimeMinutes: number, session?: ClientSession) {
        if (purpose !== 'resetPassword') throw new Error('Verification codes require bound registration credentials.');
        const code = crypto.randomInt(100_000, 1_000_000).toString();
        await withActiveAccount(userId, transaction => this.writeSlot(userId, purpose, code, lifetimeMinutes, transaction), session);
        return code;
    }

    /**
     * Issues a verification code bound to the credentials that redeeming it will
     * apply, voiding every earlier code for the account. A registration attempt
     * is also recorded as the account's pending registration, so a later resend
     * binds the newest attempt even after this code's slot has expired. Without
     * an attempt (a resend) the code binds that pending registration, or the
     * stored credentials when a reset or an earlier release left none. Returns
     * null without writing when the account is missing or no longer unverified.
     */
    static async issueVerification(userId: string, attempt?: PendingRegistration, session?: ClientSession) {
        const code = crypto.randomInt(100_000, 1_000_000).toString();
        const issued = await withActiveAccount(userId, async transaction => {
            let registration = attempt;
            if (registration) {
                if (!await User.recordPendingRegistration(userId, registration, transaction)) return false;
            } else {
                const user = await User.findById(userId, transaction);
                if (!user || user.emailVerified !== false) return false;
                registration = user.pendingRegistration ?? {
                    passwordHash: String(user.password ?? ''),
                    displayName: String(user.displayName ?? ''),
                    username: String(user.username ?? '')
                };
            }
            await this.writeSlot(userId, 'verifyEmail', code, verificationLifetimeMinutes, transaction, registration);
            return true;
        }, session);
        return issued ? code : null;
    }

    /** Replaces the account's slot for a purpose, resetting its expiry and wrong-attempt count. */
    private static writeSlot(
        userId: string,
        purpose: AuthActionPurpose,
        code: string,
        lifetimeMinutes: number,
        session: ClientSession,
        registration?: PendingRegistration
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
                failedAttempts: 0,
                ...(registration ? { registration } : {})
            },
            { upsert: true, session }
        );
    }

    /**
     * Atomically consumes a matching live code so concurrent reuse can succeed
     * only once, and returns the consumed slot (including any bound
     * registration). A wrong code counts against the live slot; the attempt that
     * reaches `maxFailedCodeAttempts` voids it in the same transaction.
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
            // The bound password hash leaves the slot as soon as the code is used.
            { $set: { consumedAt: now }, $unset: { registration: '' } },
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

    /** Voids the live code for a purpose, such as a verification code whose credentials a reset superseded. */
    static voidCurrent(userId: string, purpose: AuthActionPurpose, session: ClientSession) {
        return this.voidSlot(tokenDocumentId(userId, purpose), new Date(), session);
    }

    private static voidSlot(slotId: string, now: Date, session: ClientSession) {
        return tokens().updateOne(
            { _id: slotId, consumedAt: { $exists: false } },
            { $set: { consumedAt: now, voidedAt: now }, $unset: { registration: '' } },
            { session }
        );
    }
}

export default AuthActionToken;
