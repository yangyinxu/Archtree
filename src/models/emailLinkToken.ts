import crypto from 'crypto';
import { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';

/** `registration` links let an inbox owner choose credentials; `verifyEmail` links verify a legacy account. */
export type EmailLinkPurpose = 'registration' | 'verifyEmail';

export interface EmailLinkTokenDocument {
    /** HMAC of the raw token; the raw token exists only in the outgoing email. */
    _id: string;
    purpose: EmailLinkPurpose;
    /** Normalized lowercase address the link was mailed to. */
    email: string;
    /** `verifyEmail` only: the account the link verifies. */
    userId?: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt?: Date;
}

/** Emailed links keep the 30-minute lifetime the earlier verification codes had. */
export const emailLinkLifetimeMinutes = 30;

const linkTokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Accepts only the exact shape `issue` produces: 32 random bytes as unpadded base64url. */
export const isEmailLinkTokenFormat = (value: unknown): value is string =>
    typeof value === 'string' && linkTokenPattern.test(value);

/**
 * Derives the stored identifier for a raw link token. The purpose is part of
 * the MAC input, so a token issued for one purpose never matches another.
 */
export const hashEmailLinkToken = (purpose: EmailLinkPurpose, token: string) => {
    const pepper = process.env.AUTH_CODE_PEPPER ?? process.env.JWT_SECRET;
    if (!pepper) {
        throw new Error('Authentication code pepper is not configured.');
    }
    return crypto
        .createHmac('sha256', pepper)
        .update(`email-link:v1:${purpose}:${token}`, 'utf8')
        .digest('hex');
};

const tokens = () => getDb()!.collection<EmailLinkTokenDocument>('emailLinkTokens');

/** Matches a token that has not been consumed or expired. */
const liveFilter = (purpose: EmailLinkPurpose, token: string, now: Date) => ({
    _id: hashEmailLinkToken(purpose, token),
    purpose,
    consumedAt: { $exists: false },
    expiresAt: { $gt: now }
});

/**
 * Stores single-use, high-entropy email links only as keyed hashes. Several
 * live links per address may coexist; the per-address email budget bounds
 * them and consuming one deletes its siblings.
 */
class EmailLinkToken {
    /** Stores a new link and returns its raw token for the email that is sent next. */
    static async issue(purpose: EmailLinkPurpose, email: string, userId?: string, session?: ClientSession) {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = new Date();
        await tokens().insertOne({
            _id: hashEmailLinkToken(purpose, token),
            purpose,
            email,
            ...(userId ? { userId } : {}),
            createdAt: now,
            expiresAt: new Date(now.getTime() + emailLinkLifetimeMinutes * 60_000)
        }, { session });
        return token;
    }

    /** Reads a live link without consuming it, so a page can show what the link is for. */
    static findLive(purpose: EmailLinkPurpose, token: string, session?: ClientSession) {
        if (!isEmailLinkTokenFormat(token)) return Promise.resolve(null);
        return tokens().findOne(liveFilter(purpose, token, new Date()), { session });
    }

    /** Atomically marks a live link consumed so concurrent redemptions succeed at most once. */
    static async consume(purpose: EmailLinkPurpose, token: string, session: ClientSession) {
        if (!isEmailLinkTokenFormat(token)) return null;
        const now = new Date();
        const result = await tokens().findOneAndUpdate(
            liveFilter(purpose, token, now),
            { $set: { consumedAt: now } },
            { returnDocument: 'after', session }
        );
        return result.value;
    }

    /** Voids every other link of a purpose for an address once one of them is redeemed. */
    static deleteOthers(purpose: EmailLinkPurpose, email: string, keptId: string, session: ClientSession) {
        return tokens().deleteMany({ purpose, email, _id: { $ne: keptId } }, { session });
    }

    /** Removes the account's verification links, e.g. after a reset already verified it. */
    static deleteForUser(userId: string, session?: ClientSession) {
        return tokens().deleteMany({ userId }, { session });
    }

    /** Removes the address's registration links and the account's verification links when a record is replaced. */
    static deleteForReplacement(email: string, userId: string, session: ClientSession) {
        return tokens().deleteMany({ $or: [{ email, purpose: 'registration' }, { userId }] }, { session });
    }
}

export default EmailLinkToken;
