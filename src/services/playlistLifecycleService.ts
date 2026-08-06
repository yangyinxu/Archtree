import { ObjectId } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';

const defaultReferenceCleanupBatchSize = 100;
const maximumReferenceCleanupBatchSize = 500;

/** Reports bounded Playlist cleanup progress without exposing private Playlist data. */
export interface PlaylistReferenceCleanupBatchResult {
    playlistsUpdated: number;
    hasMore: boolean;
}

/** Summarizes one complete, possibly multi-transaction cleanup pass. */
export interface PlaylistReferenceCleanupResult {
    batches: number;
    playlistsUpdated: number;
}

const normalizedBatchSize = (value: number) => {
    if (!Number.isInteger(value) || value <= 0) return defaultReferenceCleanupBatchSize;
    return Math.min(value, maximumReferenceCleanupBatchSize);
};

/**
 * Removes one bounded batch of Playlist memberships in a transaction so item removal
 * and revision changes cannot be observed independently.
 */
export const cleanupAudioTrackPlaylistReferenceBatch = async (
    audioTrackId: string,
    batchSize: number = defaultReferenceCleanupBatchSize
): Promise<PlaylistReferenceCleanupBatchResult> => {
    const sourceAudioTrackId = String(audioTrackId).trim();
    const normalizedAudioTrackId = /^[0-9a-f]{24}$/i.test(sourceAudioTrackId)
        ? sourceAudioTrackId.toLowerCase()
        : sourceAudioTrackId;
    if (!normalizedAudioTrackId) {
        throw new Error('Audio track ID is required for Playlist reference cleanup.');
    }

    const db = getDb();
    if (!db) throw new Error('Database is unavailable.');
    const referenceValues: Array<string | ObjectId> = /^[0-9a-f]{24}$/.test(normalizedAudioTrackId)
        ? [
            normalizedAudioTrackId,
            normalizedAudioTrackId.toUpperCase(),
            ObjectId.createFromHexString(normalizedAudioTrackId)
        ]
        : [normalizedAudioTrackId];

    const databaseSession = getDatabaseClient().startSession();
    let playlistsUpdated = 0;
    try {
        await databaseSession.withTransaction(async () => {
            const playlistIds = await db.collection('playlists').find(
                { items: { $elemMatch: { audioTrackId: { $in: referenceValues } } } },
                {
                    projection: { _id: 1 },
                    session: databaseSession
                }
            )
                .sort({ _id: 1 })
                .limit(normalizedBatchSize(batchSize))
                .toArray();
            if (playlistIds.length === 0) return;

            const updatedAt = new Date();
            const result = await db.collection('playlists').updateMany(
                {
                    _id: { $in: playlistIds.map(playlist => playlist._id) },
                    items: { $elemMatch: { audioTrackId: { $in: referenceValues } } }
                },
                [
                    {
                        $set: {
                            items: {
                                $filter: {
                                    input: { $cond: [{ $isArray: '$items' }, '$items', []] },
                                    as: 'item',
                                    cond: { $not: [{
                                        $in: ['$$item.audioTrackId', referenceValues]
                                    }] }
                                }
                            },
                            revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
                            updatedAt
                        }
                    }
                ],
                { session: databaseSession }
            );
            playlistsUpdated = result.modifiedCount;
        });
    } finally {
        await databaseSession.endSession();
    }

    const hasMore = Boolean(await db.collection('playlists').findOne(
        { items: { $elemMatch: { audioTrackId: { $in: referenceValues } } } },
        { projection: { _id: 1 } }
    ));
    return { playlistsUpdated, hasMore };
};

/**
 * Repeats idempotent bounded batches until an authoritative query proves that no
 * Playlist still references the deleting Soundtrack.
 */
export const cleanupAudioTrackPlaylistReferences = async (
    audioTrackId: string,
    batchSize: number = defaultReferenceCleanupBatchSize
): Promise<PlaylistReferenceCleanupResult> => {
    let batches = 0;
    let playlistsUpdated = 0;
    let consecutiveNoProgressBatches = 0;

    while (true) {
        const result = await cleanupAudioTrackPlaylistReferenceBatch(audioTrackId, batchSize);
        if (result.playlistsUpdated > 0) {
            batches += 1;
            playlistsUpdated += result.playlistsUpdated;
            consecutiveNoProgressBatches = 0;
        } else if (result.hasMore) {
            consecutiveNoProgressBatches += 1;
            if (consecutiveNoProgressBatches >= 3) {
                throw new Error('Playlist reference cleanup could not make progress.');
            }
        }
        if (!result.hasMore) return { batches, playlistsUpdated };
    }
};
