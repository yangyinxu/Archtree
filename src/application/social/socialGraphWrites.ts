import type { ClientSession } from 'mongodb';
import { SocialError } from '../../contracts/socialV1';
import { getDb } from '../../infrastructure/database';
import type { SocialBudgetDocument, SocialOutboxDocument } from '../../repositories/social/socialDocuments';

/**
 * Graph write helpers shared by listener commands and administrator moderation. Each one
 * enlists the caller's transaction, which must already hold the affected account fences.
 */
const collection = <T extends { _id: string }>(name: string) => {
    const db = getDb();
    if (!db) throw new SocialError(503, 'social_unavailable');
    return db.collection<T>(name);
};

/** Refuses counter wrap: an exhausted clock can no longer issue an unambiguous revision. */
export const nextSocialRevision = (revision: number): number => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new SocialError(503, 'social_unavailable');
    return revision + 1;
};

/** Account-held clocks outlive pair tombstones, preventing a new pair from reusing an old revision. */
export const nextRelationshipRevision = async (accountIds: string[], minimum: number, session: ClientSession): Promise<number> => {
    const values = await collection<SocialBudgetDocument>('socialBudgets').find({ _id: { $in: accountIds } }, { session }).toArray();
    return nextSocialRevision(Math.max(minimum, ...values.map(value => value.relationshipRevision ?? 0)));
};

export const retainRelationshipRevision = async (accountIds: string[], revision: number, session: ClientSession): Promise<void> => {
    await collection<SocialBudgetDocument>('socialBudgets').bulkWrite(accountIds.map(accountId => ({ updateOne: {
        filter: { _id: accountId }, update: { $set: { accountId, relationshipRevision: revision } }, upsert: true
    } })), { session, ordered: true });
};

/** Publishes one coalesced, payload-free refresh signal per affected account. */
export const invalidateSocialAccounts = async (accountIds: string[], session: ClientSession, now: number): Promise<void> => {
    const unique = [...new Set(accountIds)].sort();
    if (unique.length) await collection<SocialOutboxDocument>('socialOutbox').bulkWrite(unique.map(accountId => ({ updateOne: {
        filter: { _id: accountId }, update: {
            $set: { accountId, updatedAt: new Date(now) }, $inc: { revision: 1 }
        }, upsert: true
    } })), { session, ordered: true });
};
