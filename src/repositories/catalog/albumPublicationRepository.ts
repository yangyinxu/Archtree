import { ObjectId } from 'mongodb';
import { getDb } from '../../infrastructure/database';
import type { Album } from '../../models/album';
import { withReadyAudioTrackReferences } from '../../services/audioTrackReferenceFenceService';
import { assignReadyAudioTracksToNewAlbum } from '../../services/albumTrackLinkService';
import { touchActiveAccount } from '../../services/accountReferenceFenceService';
import { normalizeCatalogCredits, validateAttribution } from '../../models/catalogCredit';
import { touchReadyArtistReferences } from '../../services/artistReferenceFenceService';
import { touchReadyOrganizationReferences } from '../../services/organizationReferenceFenceService';
import { requireCatalogCreditWrites } from '../../config/catalogCreditRollout';

const albumCreationWriteMayHaveCommitted = (error: any) =>
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

/** Inserts one Album and its fenced references atomically, then confirms any uncertain write. */
export const insertPublishedAlbum = async (album: Album) => {
    const db = getDb();
    if (!album._id) album._id = new ObjectId();
    const albumId = album._id.toHexString();
    try {
        return await withReadyAudioTrackReferences(
            Array.isArray(album.audioTrackIds) ? album.audioTrackIds : [],
            async (session, audioTrackIds) => {
                if (Array.isArray(album.credits)) {
                    requireCatalogCreditWrites();
                    album.credits = normalizeCatalogCredits(album.credits);
                    album.attributionStatus = validateAttribution(
                        album.attributionStatus,
                        album.credits
                    );
                    await touchReadyArtistReferences(
                        album.credits.filter((credit) => credit.subjectType === 'artist')
                            .map((credit) => credit.subjectId),
                        session
                    );
                    await touchReadyOrganizationReferences(
                        album.credits.filter((credit) => credit.subjectType === 'organization')
                            .map((credit) => credit.subjectId),
                        session
                    );
                }
                album.audioTrackIds = await assignReadyAudioTracksToNewAlbum(
                    session,
                    albumId,
                    audioTrackIds
                ) as [string];
                await touchActiveAccount(album.createdBy, session);
                return db!.collection('albums').insertOne(album, { session });
            }
        );
    } catch (error) {
        return confirmAlbumCreationAfterWriteError(album, error);
    }
};

/** Prevents retry or artwork compensation when a committed Album cannot be ruled out. */
export class AlbumCreationOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'album_creation_outcome_unknown';
    readonly cleanupPending = true;
    readonly outcomeUnknown = true;
    readonly cause: unknown;

    constructor(albumId: string, cause: unknown) {
        super(`Album ${albumId} creation outcome could not be confirmed.`);
        this.cause = cause;
    }
}

/** Recovers a committed insert whose response was lost without publishing a mismatched owner. */
export const confirmAlbumCreationAfterWriteError = async (
    album: Pick<Album, '_id' | 'title' | 'coverArtId' | 'createdBy'>,
    writeError: unknown,
    findOwner: (albumId: string) => Promise<any | null> = async (albumId) => getDb()!
        .collection('albums')
        .findOne({ _id: ObjectId.createFromHexString(albumId) })
) => {
    const albumId = album._id?.toHexString();
    if (!albumId) throw writeError;

    let owner: any | null;
    try {
        owner = await findOwner(albumId);
    } catch (confirmationError) {
        throw new AlbumCreationOutcomeUnknownError(albumId, {
            writeError,
            confirmationError
        });
    }
    if (!owner) {
        if (albumCreationWriteMayHaveCommitted(writeError)) {
            throw new AlbumCreationOutcomeUnknownError(albumId, { writeError });
        }
        throw writeError;
    }

    const expectedCoverArtId = String(album.coverArtId ?? '');
    const actualCoverArtId = String(owner.coverArtId ?? '');
    if (owner.lifecycleStatus === 'ready'
        && String(owner.title ?? '') === album.title
        && String(owner.createdBy ?? '') === album.createdBy
        && actualCoverArtId === expectedCoverArtId) {
        return { acknowledged: true, insertedId: album._id };
    }
    throw new AlbumCreationOutcomeUnknownError(albumId, { writeError });
};
