import { ClientSession, TransactionOptions } from 'mongodb';
import AuthActionToken, { AuthActionPurpose, PendingRegistration } from '../models/authActionToken';
import AuthIdentity, { AuthProvider } from '../models/authIdentity';
import AuthSession from '../models/authSession';
import { Passkey, PasskeyChallenge } from '../models/passkey';
import User from '../models/user';
import { notifyRoomChanges } from '../realtime/roomEvents';
import { AccountReferenceUnavailableError, withActiveAccount } from './accountReferenceFenceService';

// Preserve the room/session cleanup durability settings when it joins a
// credential transaction rather than opening its own transaction.
const credentialTransactionOptions: TransactionOptions = {
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
 * Refuses to link a provider or passkey until the account proves email
 * ownership. Pass the linking transaction so the check serializes with
 * verification through the account fence.
 */
export const requireVerifiedAccount = async (userId: string, session?: ClientSession) => {
    const user = await User.findById(userId, session);
    if (user?.emailVerified === false) {
        throw Object.assign(new Error('Verify your email before adding a sign-in method.'), { statusCode: 403 });
    }
};

/**
 * Applies exactly the registration attempt bound to the redeemed code, then
 * removes every session, provider identity, passkey and pending enrollment
 * that existed before ownership was proven: whoever created them never had to
 * control the mailbox. Resolves false when the code carries no credentials or
 * the account is no longer unverified.
 */
const completeEmailVerification = async (
    userId: string, registration: PendingRegistration | undefined, session: ClientSession
) => {
    if (!registration || !await User.applyVerifiedRegistration(userId, registration, session)) return false;
    // MongoDB transactions do not support parallel operations on one session.
    await AuthSession.revokeAll(userId, session);
    await AuthIdentity.deleteForUser(userId, session);
    await Passkey.deleteForUser(userId, session);
    await PasskeyChallenge.deleteForUser(userId, session);
    return true;
};

/** Consuming an email code and its durable effect commit together, including session/room cleanup. */
export const applyEmailAction = async (
    userId: string, purpose: AuthActionPurpose, code: string, passwordHash?: string
): Promise<boolean> => {
    let applied: boolean;
    try {
        applied = await withActiveAccount(userId, async session => {
            const token = await AuthActionToken.consume(userId, purpose, code, session);
            if (!token) return false;
            if (purpose === 'verifyEmail') return completeEmailVerification(userId, token.registration, session);
            if (!passwordHash) throw new Error('Password reset requires a password hash.');
            await User.updatePassword(userId, passwordHash, session);
            await AuthSession.revokeAll(userId, session);
            // On an unverified account an outstanding verification code is bound
            // to an earlier registration attempt and would overwrite this reset
            // password. A resend binds the reset password instead.
            await AuthActionToken.voidCurrent(userId, 'verifyEmail', session);
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
