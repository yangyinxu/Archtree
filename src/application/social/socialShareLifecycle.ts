import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { MUSIC_SHARE_LIMITS, type SharedMusicType } from '../../contracts/socialMusicV1';
import { SocialError } from '../../contracts/socialV1';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import type { MusicShareDocument } from '../../repositories/social/musicShareDocuments';
import type { SocialOutboxDocument } from '../../repositories/social/socialDocuments';
import { notifyRoomChanges } from '../../realtime/roomEvents';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from './socialTransactionRetry';

const shares = () => getDb()!.collection<MusicShareDocument>('socialMusicShares');
const accountLimit = MUSIC_SHARE_LIMITS.incoming + MUSIC_SHARE_LIMITS.outgoing;

/** Resolves the bounded live peer set before the parent social transaction acquires sorted account fences. */
export const musicShareAccountIds = async (filter: Filter<MusicShareDocument>, session: ClientSession, now: number): Promise<string[]> => {
    const rows = await shares().find({ ...filter, expiresAt: { $gt: new Date(now) } }, { session, projection: { accountIds: 1 } })
        .limit(accountLimit + 1).toArray();
    if (rows.length > accountLimit) throw new SocialError(503, 'social_unavailable');
    const ids = [...new Set(rows.flatMap(row => row.accountIds))].sort();
    if (!ids.length) return [];
    return (await getDb()!.collection('users').find({ _id: { $in: ids.map(id => new ObjectId(id)) } }, { session, projection: { _id: 1 } }).toArray())
        .map(user => user._id.toHexString()).sort();
};

/** Existing account writes prevent cleanup from resurrecting an outbox after concurrent account deletion. */
export const invalidateMusicShareAccounts = async (accountIds: string[], session: ClientSession, now: number): Promise<void> => {
    const ids = [...new Set(accountIds)].filter(id => /^[a-f0-9]{24}$/.test(id)).sort();
    if (!ids.length) return;
    const db = getDb()!;
    const filter = { _id: { $in: ids.map(id => new ObjectId(id)) } };
    await db.collection('users').updateMany(filter, { $inc: { listenerMutationRevision: 1 } }, { session });
    const existing = await db.collection('users').find(filter, { session, projection: { _id: 1 } }).toArray();
    for (const user of existing) {
        const accountId = user._id.toHexString();
        const outbox = db.collection<SocialOutboxDocument>('socialOutbox');
        const previous = await outbox.findOne({ _id: accountId }, { session });
        const revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision) || revision < 1) throw new SocialError(503, 'social_unavailable');
        await outbox.updateOne({ _id: accountId }, { $set: { accountId, revision, updatedAt: new Date(now) } }, { upsert: true, session });
    }
};

/** Graph and account cleanup enlist the caller transaction; expired evidence needs no recipient notification. */
export const deleteMusicShares = async (filter: Filter<MusicShareDocument>, session: ClientSession, now: number): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Music share cleanup requires a transaction.');
    const rows = await shares().find(filter, { session }).limit(accountLimit + 1).toArray();
    if (rows.length > accountLimit) throw new SocialError(503, 'social_unavailable');
    if (!rows.length) return;
    const accounts = rows.filter(row => row.expiresAt.getTime() > now).flatMap(row => row.accountIds);
    await shares().deleteMany({ _id: { $in: rows.map(row => row._id) } }, { session });
    await invalidateMusicShareAccounts(accounts, session, now);
};

/** Content is already unavailable; bounded batches retain the owner's retry evidence until all references detach. */
export const cleanupMusicSharesForContent = async (contentType: SharedMusicType, contentId: string): Promise<void> => {
    const filter = { contentType, contentId };
    for (let batch = 0; batch < 20; batch += 1) {
        let removed = 0;
        for (let attempt = 0; attempt < SOCIAL_TRANSACTION_ATTEMPTS; attempt += 1) {
            const session = getDatabaseClient().startSession();
            try {
                session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
                const rows = await shares().find(filter, { session }).sort({ _id: 1 }).limit(100).toArray();
                removed = rows.length;
                if (removed) {
                    await invalidateMusicShareAccounts(rows.flatMap(row => row.accountIds), session, Date.now());
                    await shares().deleteMany({ _id: { $in: rows.map(row => row._id) } }, { session });
                }
                await session.commitTransaction();
                break;
            } catch (error) {
                await session.abortTransaction().catch(() => undefined);
                const mongo = error as { hasErrorLabel?: (label: string) => boolean; code?: number };
                if (!mongo.hasErrorLabel?.('UnknownTransactionCommitResult') && attempt + 1 < SOCIAL_TRANSACTION_ATTEMPTS
                    && (mongo.hasErrorLabel?.('TransientTransactionError') || mongo.code === 11000)) {
                    await waitForSocialTransactionRetry(attempt); continue;
                }
                throw error;
            } finally { await session.endSession(); }
        }
        if (removed) notifyRoomChanges();
        if (removed < 100) return;
    }
    if (await shares().findOne(filter, { projection: { _id: 1 } })) throw new SocialError(503, 'social_unavailable');
};
