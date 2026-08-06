import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { cleanupDeletedContentReferences } from './contentReferenceService';
import {
    finalizeCoverArtDeletion,
    finalizeOwnerCoverArtDeletions,
    prepareCoverArtDeletion,
    prepareOwnerCoverArtDeletions
} from './imageStorageService';

const boundedError = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).substring(0, 500);

export interface ArtistDeletionDependencies {
    prepareCoverArt: (
        imageId: string | undefined | null,
        artistId: string
    ) => Promise<boolean>;
    prepareOwnerCoverArt: (
        artistId: string,
        currentImageId: string | undefined | null
    ) => Promise<string[]>;
    cleanupReferences: typeof cleanupDeletedContentReferences;
    deleteOwner: (
        artistId: string,
        referenceRevision: number
    ) => Promise<{ deletedCount: number }>;
    findOwner: (artistId: string) => Promise<any | null>;
    finalizeCoverArt: (imageId: string | undefined | null) => Promise<void>;
    finalizeOwnerCoverArt: (imageIds: readonly string[]) => Promise<void>;
}

export class ArtistDeletionOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'artist_deletion_outcome_unknown';
    readonly cleanupPending = true;
    readonly cause: unknown;

    constructor(artistId: string, cause: unknown) {
        super(`Artist ${artistId} deletion outcome could not be confirmed.`);
        this.cause = cause;
    }
}

export interface ArtistDeletionResult {
    deleted: boolean;
    ownerDeleted: boolean;
    cleanupPending: boolean;
    cleanupError?: unknown;
}

const defaultArtistDeletionDependencies: ArtistDeletionDependencies = {
    prepareCoverArt: (imageId, artistId) => prepareCoverArtDeletion(imageId, {
        expectedOwnerType: 'artist',
        expectedOwnerId: artistId
    }),
    prepareOwnerCoverArt: (artistId, currentImageId) =>
        prepareOwnerCoverArtDeletions('artist', artistId, currentImageId),
    cleanupReferences: cleanupDeletedContentReferences,
    deleteOwner: async (artistId, referenceRevision) => getDb()!
        .collection('artists')
        .deleteOne({
            _id: ObjectId.createFromHexString(artistId),
            lifecycleStatus: 'deleting',
            referenceRevision
        }),
    findOwner: artistId => getDb()!.collection('artists').findOne({
        _id: ObjectId.createFromHexString(artistId)
    }),
    finalizeCoverArt: finalizeCoverArtDeletion,
    finalizeOwnerCoverArt: finalizeOwnerCoverArtDeletions
};

/** Fences deletion before cleanup and retains retryable Artist evidence after partial failure. */
export const deleteArtistAndReferences = async (
    artistId: string,
    dependencies: Partial<ArtistDeletionDependencies> = {}
): Promise<ArtistDeletionResult> => {
    if (!/^[0-9a-f]{24}$/i.test(artistId)) {
        return { deleted: false, ownerDeleted: false, cleanupPending: false };
    }
    const canonicalArtistId = ObjectId.createFromHexString(artistId).toHexString();
    const deletion = { ...defaultArtistDeletionDependencies, ...dependencies };
    const usesLegacyCoverHooks = dependencies.prepareCoverArt !== undefined
        || dependencies.finalizeCoverArt !== undefined;
    const artists = getDb()!.collection('artists');
    const _id = ObjectId.createFromHexString(canonicalArtistId);
    const transition: any = await artists.findOneAndUpdate(
        {
            _id,
            $or: [
                { lifecycleStatus: 'ready' },
                { lifecycleStatus: 'deleteFailed' },
                { lifecycleStatus: { $exists: false } }
            ]
        },
        {
            $set: {
                lifecycleStatus: 'deleting',
                lifecycleUpdatedAt: new Date(),
                lifecycleError: null
            },
            $inc: { referenceRevision: 1 }
        },
        { returnDocument: 'after' }
    );
    const artist = transition.value;
    if (!artist) {
        const current = await artists.findOne({ _id }, { projection: { lifecycleStatus: 1 } });
        if (!current) return { deleted: false, ownerDeleted: false, cleanupPending: false };
        throw Object.assign(new Error('Artist deletion is already in progress.'), {
            statusCode: 409,
            code: 'artist_deletion_in_progress'
        });
    }

    const referenceRevision = Number(artist.referenceRevision);
    let coverArtPrepared = false;
    let preparedCoverArtIds: string[] = [];
    try {
        if (usesLegacyCoverHooks) {
            coverArtPrepared = await deletion.prepareCoverArt(artist.coverArtId, canonicalArtistId);
            if (artist.coverArtId && !coverArtPrepared) {
                throw new Error('Cover-art lifecycle evidence is missing.');
            }
            if (coverArtPrepared && artist.coverArtId) preparedCoverArtIds = [String(artist.coverArtId)];
        } else {
            preparedCoverArtIds = await deletion.prepareOwnerCoverArt(
                canonicalArtistId,
                artist.coverArtId
            );
            coverArtPrepared = preparedCoverArtIds.length > 0;
        }
        await deletion.cleanupReferences('artist', canonicalArtistId);
        let deleteError: unknown;
        try {
            const removed = await deletion.deleteOwner(canonicalArtistId, referenceRevision);
            if (removed.deletedCount !== 1) {
                deleteError = new Error(`Artist ${canonicalArtistId} could not be finalized.`);
            }
        } catch (error) {
            deleteError = error;
        }
        if (deleteError) {
            let current: any | null;
            try {
                current = await deletion.findOwner(canonicalArtistId);
            } catch (confirmationError) {
                throw new ArtistDeletionOutcomeUnknownError(canonicalArtistId, {
                    deleteError,
                    confirmationError
                });
            }
            if (current != null) throw deleteError;
        }
    } catch (error) {
        if (error instanceof ArtistDeletionOutcomeUnknownError) throw error;
        await artists.updateOne(
            { _id, lifecycleStatus: 'deleting', referenceRevision },
            {
                $set: {
                    lifecycleStatus: 'deleteFailed',
                    lifecycleUpdatedAt: new Date(),
                    lifecycleError: boundedError(error)
                }
            }
        ).catch(() => undefined);
        return {
            deleted: false,
            ownerDeleted: false,
            cleanupPending: true,
            cleanupError: error
        };
    }

    if (!coverArtPrepared) {
        return { deleted: true, ownerDeleted: true, cleanupPending: false };
    }
    try {
        if (usesLegacyCoverHooks) await deletion.finalizeCoverArt(artist.coverArtId);
        else await deletion.finalizeOwnerCoverArt(preparedCoverArtIds);
        return { deleted: true, ownerDeleted: true, cleanupPending: false };
    } catch (cleanupError) {
        return {
            deleted: true,
            ownerDeleted: true,
            cleanupPending: true,
            cleanupError
        };
    }
};
