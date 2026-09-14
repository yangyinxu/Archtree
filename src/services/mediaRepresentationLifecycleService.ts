import { ObjectId } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { invalidateRoomsForMedia } from '../application/rooms/roomLifecycle';

/** Commits active-byte changes and room invalidation together before any old S3 object is removed. */
export const updateMediaTrackStorageState = async (
    mediaTrackId: string,
    expected: Record<string, unknown>,
    update: Record<string, unknown>
): Promise<{ matchedCount: number }> => {
    const filter = { _id: ObjectId.createFromHexString(mediaTrackId), ...expected };
    const tracks = getDb()!.collection('audioTracks');
    const invalidates = typeof update.s3Key === 'string'
        || update.uploadStatus === 'deleting' || update.uploadStatus === 'deleteFailed';
    if (!invalidates) return tracks.updateOne(filter, { $set: update });
    const session = getDatabaseClient().startSession();
    try {
        for (let attempt = 0; ; attempt += 1) {
            session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
            try {
                const result = await tracks.updateOne(filter, { $set: update }, { session });
                if (result.matchedCount === 1) await invalidateRoomsForMedia(mediaTrackId, session);
                await session.commitTransaction();
                return { matchedCount: result.matchedCount };
            } catch (error: any) {
                if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
                // An uncertain commit is confirmed by the surrounding storage lifecycle, never replayed here.
                if (attempt < 2 && !error?.hasErrorLabel?.('UnknownTransactionCommitResult')
                    && error?.hasErrorLabel?.('TransientTransactionError')) continue;
                throw error;
            }
        }
    } finally {
        await session.endSession();
    }
};
