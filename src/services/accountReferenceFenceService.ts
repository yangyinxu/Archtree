import { ClientSession, ObjectId, TransactionOptions } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';

export class AccountReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'account_unavailable';

    constructor() {
        super('The listener account is unavailable.');
    }
}

/** Serializes account-owned writes with the transaction that removes the account. */
export const touchActiveAccount = async (userId: string, session: ClientSession) => {
    if (!/^[0-9a-f]{24}$/i.test(userId)) throw new AccountReferenceUnavailableError();
    const touched = await getDb()!.collection('users').updateOne(
        { _id: ObjectId.createFromHexString(userId) },
        { $inc: { listenerMutationRevision: 1 } },
        { session }
    );
    if (touched.matchedCount !== 1) throw new AccountReferenceUnavailableError();
};

/** Commits account-owned/provenance writes only while the owning account still exists. */
export const withActiveAccount = async <T>(
    userId: string,
    mutation: (session: ClientSession) => Promise<T>,
    existingSession?: ClientSession,
    transactionOptions?: TransactionOptions
): Promise<T> => {
    // Authentication composes several fenced writes in one transaction. Reuse
    // its session so nested models never start a competing account transaction.
    if (existingSession) {
        if (!existingSession.inTransaction()) throw new Error('An active account transaction is required.');
        await touchActiveAccount(userId, existingSession);
        return mutation(existingSession);
    }
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            await touchActiveAccount(userId, session);
            result = await mutation(session);
        }, transactionOptions);
    } finally {
        await session.endSession();
    }
    return result as T;
};
