import { ClientSession, ObjectId } from 'mongodb';

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

/** Commits a provenance-bearing write only while its creator account still exists. */
export const withActiveAccount = async <T>(
    userId: string,
    mutation: (session: ClientSession) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            await touchActiveAccount(userId, session);
            result = await mutation(session);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
