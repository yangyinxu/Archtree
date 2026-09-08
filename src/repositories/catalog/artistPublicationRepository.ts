import { ObjectId } from 'mongodb';
import { getDb } from '../../infrastructure/database';
import type { Artist } from '../../models/artist';
import { withReadyAlbumReferences } from '../../services/albumReferenceFenceService';
import { touchActiveAccount } from '../../services/accountReferenceFenceService';

const artistCreationWriteMayHaveCommitted = (error: any) =>
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

/** Inserts one Artist and its fenced references atomically, then confirms any uncertain write. */
export const insertPublishedArtist = async (artist: Artist) => {
    const db = getDb();
    try {
        return await withReadyAlbumReferences(
            Array.isArray(artist.albumIds) ? artist.albumIds : [],
            async (session, albumIds) => {
                artist.albumIds = albumIds as [string];
                await touchActiveAccount(artist.createdBy, session);
                return db!.collection('artists').insertOne(artist, { session });
            }
        );
    } catch (error) {
        return confirmArtistCreationAfterWriteError(artist, error);
    }
};

/** Prevents retry or artwork compensation when a committed Artist cannot be ruled out. */
export class ArtistCreationOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'artist_creation_outcome_unknown';
    readonly cleanupPending = true;
    readonly outcomeUnknown = true;
    readonly cause: unknown;

    constructor(artistId: string, cause: unknown) {
        super(`Artist ${artistId} creation outcome could not be confirmed.`);
        this.cause = cause;
    }
}

/** Recovers a committed insert whose response was lost without publishing a mismatched owner. */
export const confirmArtistCreationAfterWriteError = async (
    artist: Pick<Artist, '_id' | 'name' | 'coverArtId' | 'createdBy'>,
    writeError: unknown,
    findOwner: (artistId: string) => Promise<any | null> = async (artistId) => getDb()!
        .collection('artists')
        .findOne({ _id: ObjectId.createFromHexString(artistId) })
) => {
    const artistId = artist._id?.toHexString();
    if (!artistId) throw writeError;

    let owner: any | null;
    try {
        owner = await findOwner(artistId);
    } catch (confirmationError) {
        throw new ArtistCreationOutcomeUnknownError(artistId, {
            writeError,
            confirmationError
        });
    }
    if (!owner) {
        if (artistCreationWriteMayHaveCommitted(writeError)) {
            throw new ArtistCreationOutcomeUnknownError(artistId, { writeError });
        }
        throw writeError;
    }

    const expectedCoverArtId = String(artist.coverArtId ?? '');
    const actualCoverArtId = String(owner.coverArtId ?? '');
    if (owner.lifecycleStatus === 'ready'
        && String(owner.name ?? '') === artist.name
        && String(owner.createdBy ?? '') === artist.createdBy
        && actualCoverArtId === expectedCoverArtId) {
        return { acknowledged: true, insertedId: artist._id };
    }
    throw new ArtistCreationOutcomeUnknownError(artistId, { writeError });
};
