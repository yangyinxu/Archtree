import { ClientSession, ObjectId } from 'mongodb';

import { SOCIAL_LIMITS } from '../contracts/socialV1';
import { getDb } from '../infrastructure/database';
import type { SocialOutboxDocument, SocialRelationshipDocument } from '../repositories/social/socialDocuments';

/**
 * Removes social identity in the account-deletion transaction after its existing
 * account fence and avatar/provenance preconditions have succeeded. Peer fences
 * prevent a deletion invalidation from recreating a concurrently deleted account.
 */
export const deleteSocialAccountData = async (
    accountId: string,
    session: ClientSession,
    now = new Date()
): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Social account cleanup requires its account-deletion transaction.');
    const db = getDb()!;
    const relationships = await db.collection<SocialRelationshipDocument>('socialRelationships')
        .find({ accountIds: accountId }, { session, projection: { accountIds: 1 } })
        .limit(SOCIAL_LIMITS.edges + 1).toArray();
    if (relationships.length > SOCIAL_LIMITS.edges) {
        throw new Error('Social account cleanup exceeded its bounded relationship limit.');
    }
    const peerIds = [...new Set(relationships.flatMap(relationship => relationship.accountIds))]
        .filter(id => id !== accountId && /^[a-f0-9]{24}$/.test(id)).sort();
    let existingPeerIds: string[] = [];
    if (peerIds.length) {
        const peerQuery = { _id: { $in: peerIds.map(id => ObjectId.createFromHexString(id)) } };
        await db.collection('users').updateMany(
            peerQuery, { $inc: { listenerMutationRevision: 1 } }, { session }
        );
        existingPeerIds = (await db.collection('users')
            .find(peerQuery, { session, projection: { _id: 1 } }).toArray())
            .map(user => user._id.toHexString()).sort();
    }

    await db.collection('socialRelationships').deleteMany({ accountIds: accountId }, { session });
    for (const collection of ['socialProfiles', 'socialMutations', 'socialBudgets', 'socialOutbox']) {
        await db.collection(collection).deleteMany({ accountId }, { session });
    }
    // The temporary reservation keeps only the handle and deadline, never its former owner.
    await db.collection('socialHandles').updateMany(
        { accountId },
        { $unset: { accountId: '' }, $set: { expiresAt: new Date(now.getTime() + SOCIAL_LIMITS.handleReservationMs) } },
        { session }
    );
    if (existingPeerIds.length) {
        await db.collection<SocialOutboxDocument>('socialOutbox').bulkWrite(
            existingPeerIds.map(peerId => ({ updateOne: {
                filter: { _id: peerId },
                update: { $set: { accountId: peerId, updatedAt: now }, $inc: { revision: 1 } },
                upsert: true
            } })),
            { session, ordered: true }
        );
    }
};
