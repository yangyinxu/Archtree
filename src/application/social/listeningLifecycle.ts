import type { ClientSession } from 'mongodb';
import { SocialError } from '../../contracts/socialV1';
import { getDatabaseClient, getDb } from '../../infrastructure/database';
import type { ListeningPublicationDocument, ListeningStateDocument } from '../../repositories/social/listeningDocuments';
import type { RoomMemberDocument } from '../../repositories/social/roomDocuments';
import { SOCIAL_TRANSACTION_ATTEMPTS, waitForSocialTransactionRetry } from './socialTransactionRetry';

/** Persistent clocks never wrap or disappear with an expired publication. */
export const nextListeningRevision = (revision: number): number => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new SocialError(503, 'social_unavailable');
    return revision + 1;
};

/** Invalidates only the captured owner lease; no upsert can resurrect a deleted account. */
export const retireListeningPublication = async (publication: ListeningPublicationDocument, session: ClientSession, now: number): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Listening invalidation requires a transaction.');
    const db = getDb()!;
    const removed = await db.collection<ListeningPublicationDocument>('socialListeningPublications').deleteOne({ _id: publication._id,
        publicationId: publication.publicationId, publisherRevision: publication.publisherRevision }, { session });
    if (removed.deletedCount) await db.collection<ListeningStateDocument>('socialListeningStates').updateOne({ _id: publication._id,
        publisherRevision: publication.publisherRevision }, { $set: { publisherRevision: nextListeningRevision(publication.publisherRevision), updatedAt: new Date(now) } }, { session });
};

/** Deactivation preserves version evidence while account deletion removes both private records. */
export const clearListeningAccount = async (accountId: string, session: ClientSession, now: number, deleted = false): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Listening cleanup requires a transaction.');
    const db = getDb()!;
    await db.collection<ListeningPublicationDocument>('socialListeningPublications').deleteOne({ _id: accountId }, { session });
    const states = db.collection<ListeningStateDocument>('socialListeningStates');
    if (deleted) { await states.deleteOne({ _id: accountId }, { session }); return; }
    const current = await states.findOne({ _id: accountId }, { session });
    if (current) await states.updateOne({ _id: accountId }, { $set: { enabled: false,
        revision: current.enabled ? nextListeningRevision(current.revision) : current.revision,
        publisherRevision: nextListeningRevision(current.publisherRevision), updatedAt: new Date(now) } }, { session });
};

/** A room suspension clears only its matching controller run; a fresh actual occurrence may reuse the lease. */
export const suppressRoomListening = async (roomId: string, member: RoomMemberDocument, session: ClientSession): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Room listening cleanup requires a transaction.');
    const publications = getDb()!.collection<ListeningPublicationDocument>('socialListeningPublications');
    const publication = await publications.findOne({ _id: member.accountId, sessionId: member.controllerSessionId,
        clientId: member.controllerClientId, 'playback.room.roomId': roomId, 'playback.room.memberId': member.membershipId,
        'playback.room.controllerGeneration': member.controllerGeneration }, { session });
    if (!publication?.playback || (!publication.visible && publication.blockedOccurrenceId === publication.playback.occurrenceId)) return;
    await publications.updateOne({ _id: publication._id, publicationId: publication.publicationId, publisherRevision: publication.publisherRevision },
        { $set: { visible: false, blockedOccurrenceId: publication.playback.occurrenceId } }, { session });
};

/** The source visibility barrier has already committed; bounded batches finish private reference cleanup. */
export const cleanupListeningForContent = async (mediaTrackId: string): Promise<void> => {
    const publications = getDb()!.collection<ListeningPublicationDocument>('socialListeningPublications');
    for (let batch = 0; batch < 20; batch += 1) {
        let count = 0;
        for (let attempt = 0; attempt < SOCIAL_TRANSACTION_ATTEMPTS; attempt += 1) {
            const session = getDatabaseClient().startSession();
            try {
                session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
                const values = await publications.find({ 'playback.mediaTrackId': mediaTrackId }, { session }).sort({ _id: 1 }).limit(100).toArray();
                count = values.length;
                for (const value of values) await retireListeningPublication(value, session, Date.now());
                await session.commitTransaction(); break;
            } catch (error) {
                await session.abortTransaction().catch(() => undefined);
                const mongo = error as { code?: number; hasErrorLabel?: (label: string) => boolean };
                if (!mongo.hasErrorLabel?.('UnknownTransactionCommitResult') && attempt + 1 < SOCIAL_TRANSACTION_ATTEMPTS
                    && (mongo.code === 11000 || mongo.hasErrorLabel?.('TransientTransactionError'))) {
                    await waitForSocialTransactionRetry(attempt); continue;
                }
                throw error;
            } finally { await session.endSession(); }
        }
        if (count < 100) return;
    }
    if (await publications.findOne({ 'playback.mediaTrackId': mediaTrackId }, { projection: { _id: 1 } })) throw new SocialError(503, 'social_unavailable');
};
