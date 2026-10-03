import { ClientSession, MongoServerError } from 'mongodb';
import { getDatabaseClient } from '../infrastructure/database';
import { consumeLinkEmailBudget } from '../middleware/requestProtectionMiddleware';
import EmailLinkToken from '../models/emailLinkToken';
import User from '../models/user';
import { notifyRoomChanges } from '../realtime/roomEvents';
import { AccountReferenceUnavailableError, withActiveAccount } from './accountReferenceFenceService';
import { requireAuthLinkConfiguration, sendAuthEmail } from './authEmailService';
import { credentialTransactionOptions, replacePendingRecord } from './authCredentialService';
import { EmailVerificationSubject, emailVerificationState } from './emailVerificationService';
import { recordSecurityEvent } from './securityAuditService';

const lowercaseEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Spends the address's shared link-email budget before any token is written.
 * Over budget, nothing is stored or sent and only an opaque event is recorded,
 * so the caller's response never changes. The budget is spent before
 * `sendAuthEmail` checks the recipient's domain, so an email skipped because
 * the domain cannot receive mail still counts, exactly like a failed delivery.
 */
const withinLinkEmailBudget = async (email: string, send: () => Promise<unknown>) => {
    requireAuthLinkConfiguration();
    if (!consumeLinkEmailBudget(email)) {
        recordSecurityEvent('auth_link_email_suppressed');
        return false;
    }
    await send();
    return true;
};

/**
 * Stores a registration link for `email`, then mails it (T1). A token is never
 * sent before it is stored, and never stored when the domain cannot receive it.
 */
export const sendRegistrationLink = (email: string) => withinLinkEmailBudget(email, () =>
    sendAuthEmail(email, 'T1', async () => ({ template: 'T1', token: await EmailLinkToken.issue('registration', email) })));

/** Mails the "already registered" notice (T2); it carries no token and changes nothing. */
export const sendAlreadyRegisteredNotice = (email: string) => withinLinkEmailBudget(email, () =>
    sendAuthEmail(email, 'T2', () => ({ template: 'T2' })));

/** Stores a verification link for a legacy account, then mails it (T3). */
export const sendVerificationLink = (email: string, userId: string) => withinLinkEmailBudget(email, () =>
    sendAuthEmail(email, 'T3', async () => ({ template: 'T3', token: await EmailLinkToken.issue('verifyEmail', email, userId) })));

/**
 * Mails the follow-up for a sign-in that presented a valid credential for an
 * unverified account. Callers run it after their `403` has been written,
 * inside the tracked request work. A legacy account receives a verification
 * link that keeps its password. A record from the earlier code-based sign-up
 * receives a registration link instead, so whoever set that record's password
 * never gains a verified account when the inbox owner clicks. Failures are
 * recorded only as an opaque event.
 */
export const sendSignInVerificationEmail = async (account: EmailVerificationSubject) => {
    try {
        const email = lowercaseEmail(account.email);
        const state = await emailVerificationState(account);
        if (state === 'legacy_unverified') await sendVerificationLink(email, account._id.toString());
        else if (state === 'pending_record') await sendRegistrationLink(email);
    } catch {
        recordSecurityEvent('auth_link_email_failed');
    }
};

export type RegistrationCompletion =
    | { status: 'created' | 'replaced'; email: string; userId: string }
    | { status: 'exists' }
    | { status: 'invalid' };

/** Runs one completion attempt: consume, classify, create or replace, and void sibling links. */
const completeRegistrationInTransaction = async (
    token: string, passwordHash: string, displayName: string, session: ClientSession
): Promise<RegistrationCompletion> => {
    const link = await EmailLinkToken.consume('registration', token, session);
    if (!link) return { status: 'invalid' };
    const existing = await User.findByEmail(link.email, session);
    let completion: RegistrationCompletion;
    if (!existing) {
        const userId = await User.insertVerified(
            { email: link.email, password: passwordHash, displayName, username: '' },
            session
        );
        completion = { status: 'created', email: link.email, userId };
    } else if (existing.emailVerified === false) {
        const userId = existing._id.toString();
        // The fence joins this transaction, so consuming the link, replacing
        // the record and its cleanup commit or roll back together.
        const replaced = await replacePendingRecord(userId, { password: passwordHash, displayName, username: '' }, session);
        completion = replaced ? { status: 'replaced', email: link.email, userId } : { status: 'exists' };
    } else {
        // A verified or legacy account keeps everything; the link stays consumed.
        completion = { status: 'exists' };
    }
    await EmailLinkToken.deleteOthers('registration', link.email, link._id, session);
    return completion;
};

const isDuplicateKeyError = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

/**
 * Redeems a registration link with credentials chosen after the inbox owner
 * opened it. In one transaction the link is consumed, then the address gets a
 * new verified account, or its unverified record from the earlier code-based
 * sign-up is replaced completely, and every other registration link for the
 * address is voided. A verified or legacy account is left unchanged. Any
 * failure rolls back, so the same link can be used again. A duplicate-key
 * error means a concurrent completion for the address won; one more attempt
 * then reports the account as existing, or the link as void.
 */
export const completeEmailRegistration = async (
    token: string, passwordHash: string, displayName: string
): Promise<RegistrationCompletion> => {
    for (let attempt = 0; ; attempt += 1) {
        const session = getDatabaseClient().startSession();
        // Assigned inside the transaction callback, which TypeScript's narrowing cannot see.
        let completion = { status: 'invalid' } as RegistrationCompletion;
        try {
            await session.withTransaction(async () => {
                completion = await completeRegistrationInTransaction(token, passwordHash, displayName, session);
            }, credentialTransactionOptions);
        } catch (error) {
            if (isDuplicateKeyError(error) && attempt === 0) continue;
            // The pending record was deleted concurrently; nothing was consumed.
            if (error instanceof AccountReferenceUnavailableError) return { status: 'invalid' };
            throw error;
        } finally {
            await session.endSession();
        }
        if (completion.status === 'replaced') notifyRoomChanges();
        return completion;
    }
};

/** Rolls back a confirmation whose link no longer matches its account. */
class EmailLinkMismatchError extends Error {}

/**
 * Whether a verification link may verify its account: the account still has
 * the address the link was mailed to and is not a record from the earlier
 * code-based sign-up (those must register instead).
 */
const verificationLinkMatches = (user: Record<string, unknown> | null, linkEmail: string) =>
    Boolean(user && lowercaseEmail(user.email) === linkEmail && user.emailVerified !== false);

/** Returns the address a live verification link would verify, or null when it cannot be used. */
export const inspectEmailVerificationLink = async (token: string) => {
    const link = await EmailLinkToken.findLive('verifyEmail', token);
    if (!link?.userId) return null;
    const user = await User.findById(link.userId);
    return verificationLinkMatches(user, link.email) ? link.email : null;
};

/**
 * Redeems a verification link for an account created before verification
 * existed. It verifies the email without changing the password and, because
 * no credential changes, keeps sessions, identities and passkeys. An account
 * that is already verified stays unchanged and the request still succeeds.
 * Resolves the account ID, or null when the link cannot be used; a rejected
 * link is rolled back and stays unconsumed.
 */
export const confirmEmailVerificationLink = async (token: string): Promise<string | null> => {
    const link = await EmailLinkToken.findLive('verifyEmail', token);
    const userId = link?.userId;
    if (!userId) return null;
    try {
        return await withActiveAccount(userId, async session => {
            const consumed = await EmailLinkToken.consume('verifyEmail', token, session);
            const user = await User.findById(userId, session);
            if (!consumed || consumed.userId !== userId || !verificationLinkMatches(user, consumed.email)) {
                throw new EmailLinkMismatchError();
            }
            await User.confirmLegacyEmail(userId, session);
            await EmailLinkToken.deleteOthers('verifyEmail', consumed.email, consumed._id, session);
            return userId;
        }, undefined, credentialTransactionOptions);
    } catch (error) {
        if (error instanceof EmailLinkMismatchError || error instanceof AccountReferenceUnavailableError) return null;
        throw error;
    }
};
