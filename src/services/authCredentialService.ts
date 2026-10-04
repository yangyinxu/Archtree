import { ClientSession, TransactionOptions } from 'mongodb';
import AuthActionToken from '../models/authActionToken';
import AuthIdentity, { AuthProvider } from '../models/authIdentity';
import AuthSession from '../models/authSession';
import EmailLinkToken from '../models/emailLinkToken';
import { Passkey, PasskeyChallenge } from '../models/passkey';
import User from '../models/user';
import { notifyRoomChanges } from '../realtime/roomEvents';
import { AccountReferenceUnavailableError, withActiveAccount } from './accountReferenceFenceService';
import {
    addMethodVerificationRequiredMessage,
    EmailVerificationRequiredError,
    emailVerificationState
} from './emailVerificationService';
import { recordSecurityEvent } from './securityAuditService';

// Preserve the room/session cleanup durability settings when it joins a
// credential transaction rather than opening its own transaction.
export const credentialTransactionOptions: TransactionOptions = {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000
};

/** Rechecks an authenticated request after expensive credential work or an account-fence wait. */
export const requireActiveAuthSession = async (userId: string, sessionId: string, session: ClientSession) => {
    const current = await AuthSession.findActiveById(sessionId, session);
    if (!current || current.userId !== userId) {
        throw Object.assign(new Error('Authentication failed.'), { statusCode: 401 });
    }
};

/**
 * Refuses to link a provider or passkey until the account's email is
 * verified. Pass the linking transaction so the check serializes with
 * verification and replacement through the account fence. It sends no email.
 */
export const requireVerifiedAccount = async (userId: string, session?: ClientSession) => {
    const user = await User.findById(userId, session);
    if (user && await emailVerificationState(user, session) !== 'verified') {
        throw new EmailVerificationRequiredError(undefined, addMethodVerificationRequiredMessage);
    }
};

/** Credentials that replace a record left by the earlier code-based sign-up. */
export interface PendingRecordReplacement {
    /** A bcrypt hash, or `''` for a provider-only account. */
    password: string;
    displayName: string;
    username: string;
}

/**
 * Replaces an unverified record left by the earlier code-based sign-up with a
 * verified account holding only `replacement`, inside the caller's
 * transaction and the account fence. Every session, provider identity,
 * passkey, pending enrollment, reset code and link that existed before is
 * removed: whoever created them never proved control of the inbox. The `_id`
 * is kept, and the record can own no other data because it could never open
 * a session. Resolves false without writing when the record is missing or no
 * longer unverified; callers re-classify the address. Callers call
 * `notifyRoomChanges()` after commit.
 */
export const replacePendingRecord = (
    userId: string, replacement: PendingRecordReplacement, session: ClientSession
) => withActiveAccount(userId, async transaction => {
    const current = await User.findById(userId, transaction);
    if (!current || current.emailVerified !== false) return false;
    const now = new Date();
    const email = String(current.email ?? '').toLowerCase();
    const retainedAvatar = Object.fromEntries((['avatarAssetId', 'avatarRevision', 'avatarUpdatedAt'] as const)
        .filter(field => current[field] !== undefined)
        .map(field => [field, current[field]]));
    const document = {
        _id: current._id,
        email,
        password: replacement.password,
        username: replacement.username,
        posts: [],
        role: 'user',
        displayName: replacement.displayName,
        emailVerified: true,
        emailVerifiedAt: now,
        ...(replacement.password ? { passwordUpdatedAt: now } : {}),
        // The fence above already advanced this revision inside the transaction.
        ...(current.listenerMutationRevision !== undefined
            ? { listenerMutationRevision: current.listenerMutationRevision }
            : {}),
        // A pending record cannot upload an avatar; keep any reference so its
        // storage object stays traceable rather than silently orphaned.
        ...retainedAvatar
    };
    if (!await User.replacePendingRecord(userId, document, transaction)) return false;
    if (Object.keys(retainedAvatar).length > 0) recordSecurityEvent('pending_record_avatar_retained', { userId });
    // MongoDB transactions do not support parallel operations on one session.
    await AuthSession.revokeAll(userId, transaction);
    await AuthIdentity.deleteForUser(userId, transaction);
    await Passkey.deleteForUser(userId, transaction);
    await PasskeyChallenge.deleteForUser(userId, transaction);
    await AuthActionToken.deleteForUser(userId, transaction);
    await EmailLinkToken.deleteForReplacement(email, userId, transaction);
    return true;
}, session);

/**
 * Consumes a reset code and applies the new password, session revocation and
 * proof of inbox control in one transaction, including session/room cleanup.
 * A record from the earlier code-based sign-up never accepts a reset: whoever
 * set its password must not gain the account through the owner's inbox, so
 * recovery sends it a registration link instead. On an account that was not
 * verified before, the reset also removes every provider identity, passkey and
 * pending enrollment that predates it. Wrong codes still count toward voiding.
 */
export const applyPasswordReset = async (userId: string, code: string, passwordHash: string): Promise<boolean> => {
    let applied: boolean;
    try {
        applied = await withActiveAccount(userId, async session => {
            const user = await User.findById(userId, session);
            if (!user) return false;
            const stateBefore = await emailVerificationState(user, session);
            if (stateBefore === 'pending_record') return false;
            const token = await AuthActionToken.consume(userId, 'resetPassword', code, session);
            if (!token) return false;
            await User.updatePassword(userId, passwordHash, session);
            await AuthSession.revokeAll(userId, session);
            if (stateBefore === 'legacy_unverified') {
                await AuthIdentity.deleteForUser(userId, session);
                await Passkey.deleteForUser(userId, session);
                await PasskeyChallenge.deleteForUser(userId, session);
            }
            await User.markEmailVerified(userId, session);
            await EmailLinkToken.deleteForUser(userId, session);
            return true;
        }, undefined, credentialTransactionOptions);
    } catch (error) {
        if (error instanceof AccountReferenceUnavailableError) return false;
        throw error;
    }
    if (applied) notifyRoomChanges();
    return applied;
};

/** Rejects stale password verification and commits the password with other-session cleanup. */
export const changeAccountPassword = async (
    userId: string, sessionId: string, expectedPassword: string | undefined, passwordHash: string
) => {
    await withActiveAccount(userId, async session => {
        await requireActiveAuthSession(userId, sessionId, session);
        const current = await User.findById(userId, session);
        if (current?.password !== expectedPassword) {
            throw Object.assign(new Error('The current password is incorrect.'), { statusCode: 400 });
        }
        await User.updatePassword(userId, passwordHash, session);
        await AuthSession.revokeAllExcept(userId, sessionId, session);
    }, undefined, credentialTransactionOptions);
    notifyRoomChanges();
};

/** Serializes the last-recovery-method check with every credential writer and account deletion. */
export const unlinkAccountProvider = (userId: string, provider: AuthProvider, sessionId?: string) => withActiveAccount(userId, async session => {
    if (sessionId) await requireActiveAuthSession(userId, sessionId, session);
    // MongoDB transactions do not support parallel operations on one session.
    const user = await User.findById(userId, session);
    const identities = await AuthIdentity.listForUser(userId, session);
    const passkeys = await Passkey.listForUser(userId, session);
    const methodCount = (user?.password ? 1 : 0) + identities.length + (passkeys.length ? 1 : 0);
    if (methodCount <= 1) return false;
    await AuthIdentity.deleteForUserAndProvider(userId, provider, session);
    return true;
});
