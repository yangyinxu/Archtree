import { ClientSession, TransactionOptions } from 'mongodb';
import AuthActionToken, { AuthActionPurpose } from '../models/authActionToken';
import AuthIdentity, { AuthProvider } from '../models/authIdentity';
import AuthSession from '../models/authSession';
import { Passkey } from '../models/passkey';
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

/** Consuming a recovery code and its durable effect commit together, including session/room cleanup. */
export const applyEmailAction = async (
    userId: string, purpose: AuthActionPurpose, code: string, passwordHash?: string
): Promise<boolean> => {
    let applied: boolean;
    try {
        applied = await withActiveAccount(userId, async session => {
            if (!await AuthActionToken.consume(userId, purpose, code, session)) return false;
            if (purpose === 'verifyEmail') await User.markEmailVerified(userId, session);
            else {
                if (!passwordHash) throw new Error('Password reset requires a password hash.');
                await User.updatePassword(userId, passwordHash, session);
                await AuthSession.revokeAll(userId, session);
            }
            return true;
        }, undefined, credentialTransactionOptions);
    } catch (error) {
        if (error instanceof AccountReferenceUnavailableError) return false;
        throw error;
    }
    if (applied && purpose === 'resetPassword') notifyRoomChanges();
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
