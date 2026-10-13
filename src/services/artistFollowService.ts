import type { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { isArtistFollowEnabled } from '../config/artistFollowRollout';
import type { ArtistFollowDocument, ArtistFollowStatus } from '../models/artistFollow';
import { withActiveAccount } from './accountReferenceFenceService';
import { ArtistReferenceUnavailableError, touchReadyArtistReferences } from './artistReferenceFenceService';

export class ArtistFollowError extends Error {
    constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

/** Rejects coercion/whitespace, while accepting and normalizing hexadecimal case. */
export const canonicalFollowArtistId = (value: unknown): string | null =>
    typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : null;

const status = (artistId: string, row?: Pick<ArtistFollowDocument, 'followedAt'> | null): ArtistFollowStatus => ({
    artistId,
    following: Boolean(row),
    followedAt: row ? row.followedAt.toISOString() : null
});

/** Bounded, input-ordered owner-only status remains available while admission is disabled. */
export const artistFollowStatuses = async (userId: string, artistIds: readonly string[]) => {
    const rows = await getDb()!.collection<ArtistFollowDocument>('artistFollows').find({
        userId, artistId: { $in: [...new Set(artistIds)] }
    }, { projection: { artistId: 1, followedAt: 1 } }).maxTimeMS(3_000).toArray();
    const byId = new Map(rows.map(row => [row.artistId, row]));
    return artistIds.map(id => status(id, byId.get(id)));
};

export interface ArtistFollowHooks {
    /** Test coordination only; production always holds the account and Artist write fences. */
    afterArtistFence?: (session: ClientSession) => Promise<void>;
}

/** Upsert and original follow time share the account/Artist deletion transaction boundary. */
export const followArtist = async (userId: string, artistId: string, hooks: ArtistFollowHooks = {}) => {
    if (!isArtistFollowEnabled()) throw new ArtistFollowError(503, 'ARTIST_FOLLOWS_DISABLED', 'Artist Follow is temporarily unavailable.');
    try {
        return await withActiveAccount(userId, async session => {
            await touchReadyArtistReferences([artistId], session);
            await hooks.afterArtistFence?.(session);
            const now = new Date();
            const result = await getDb()!.collection<ArtistFollowDocument>('artistFollows').findOneAndUpdate(
                { userId, artistId },
                { $setOnInsert: { userId, artistId, followedAt: now }, $set: { updatedAt: now } },
                { upsert: true, returnDocument: 'after', session }
            );
            return status(artistId, result.value);
        });
    } catch (error) {
        if (error instanceof ArtistReferenceUnavailableError) {
            throw new ArtistFollowError(404, 'ARTIST_UNAVAILABLE', 'Artist was not found.');
        }
        throw error;
    }
};

/** No Artist lookup: unavailable/deleted targets remain removable, including after rollout rollback. */
export const unfollowArtist = (userId: string, artistId: string) => withActiveAccount(userId, async session => {
    await getDb()!.collection('artistFollows').deleteOne({ userId, artistId }, { session });
    return status(artistId);
});
