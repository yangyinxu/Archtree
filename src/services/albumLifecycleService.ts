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

export interface AlbumDeletionDependencies {
    prepareCoverArt: (
        imageId: string | undefined | null,
        albumId: string
    ) => Promise<boolean>;
    prepareOwnerCoverArt: (
        albumId: string,
        currentImageId: string | undefined | null
    ) => Promise<string[]>;
    cleanupReferences: typeof cleanupDeletedContentReferences;
    deleteOwner: (
        albumId: string,
        referenceRevision: number
    ) => Promise<{ deletedCount: number }>;
    findOwner: (albumId: string) => Promise<any | null>;
    finalizeCoverArt: (imageId: string | undefined | null) => Promise<void>;
    finalizeOwnerCoverArt: (imageIds: readonly string[]) => Promise<void>;
}

export interface AlbumDeletionResult {
    deleted: boolean;
    ownerDeleted: boolean;
    cleanupPending: boolean;
    cleanupError?: unknown;
}

export class AlbumDeletionOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'album_deletion_outcome_unknown';
    readonly cleanupPending = true;
    readonly cause: unknown;

    constructor(albumId: string, cause: unknown) {
        super(`Album ${albumId} deletion outcome could not be confirmed.`);
        this.cause = cause;
    }
}

const defaultAlbumDeletionDependencies: AlbumDeletionDependencies = {
    prepareCoverArt: (imageId, albumId) => prepareCoverArtDeletion(imageId, {
        expectedOwnerType: 'album',
        expectedOwnerId: albumId
    }),
    prepareOwnerCoverArt: (albumId, currentImageId) =>
        prepareOwnerCoverArtDeletions('album', albumId, currentImageId),
    cleanupReferences: cleanupDeletedContentReferences,
    deleteOwner: async (albumId, referenceRevision) => getDb()!.collection('albums').deleteOne({
        _id: ObjectId.createFromHexString(albumId),
        lifecycleStatus: 'deleting',
        referenceRevision
    }),
    findOwner: albumId => getDb()!.collection('albums').findOne({
        _id: ObjectId.createFromHexString(albumId)
    }),
    finalizeCoverArt: finalizeCoverArtDeletion,
    finalizeOwnerCoverArt: finalizeOwnerCoverArtDeletions
};

/** Fences deletion, removes exact lifecycle resources, then cleans every shared reference. */
export const deleteAlbumAndReferences = async (
    albumId: string,
    dependencies: Partial<AlbumDeletionDependencies> = {}
): Promise<AlbumDeletionResult> => {
    if (!/^[0-9a-f]{24}$/i.test(albumId)) {
        return { deleted: false, ownerDeleted: false, cleanupPending: false };
    }
    const canonicalAlbumId = ObjectId.createFromHexString(albumId).toHexString();
    const deletion = { ...defaultAlbumDeletionDependencies, ...dependencies };
    const usesLegacyCoverHooks = dependencies.prepareCoverArt !== undefined
        || dependencies.finalizeCoverArt !== undefined;
    const albums = getDb()!.collection('albums');
    const _id = ObjectId.createFromHexString(canonicalAlbumId);
    const transition: any = await albums.findOneAndUpdate(
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
    const album = transition.value;
    if (!album) {
        const current = await albums.findOne({ _id }, { projection: { lifecycleStatus: 1 } });
        if (!current) return { deleted: false, ownerDeleted: false, cleanupPending: false };
        throw Object.assign(new Error('Album deletion is already in progress.'), {
            statusCode: 409,
            code: 'album_deletion_in_progress'
        });
    }

    const referenceRevision = Number(album.referenceRevision);
    let coverArtPrepared = false;
    let preparedCoverArtIds: string[] = [];
    try {
        if (usesLegacyCoverHooks) {
            coverArtPrepared = await deletion.prepareCoverArt(album.coverArtId, canonicalAlbumId);
            if (album.coverArtId && !coverArtPrepared) {
                throw new Error('Cover-art lifecycle evidence is missing.');
            }
            if (coverArtPrepared && album.coverArtId) preparedCoverArtIds = [String(album.coverArtId)];
        } else {
            preparedCoverArtIds = await deletion.prepareOwnerCoverArt(
                canonicalAlbumId,
                album.coverArtId
            );
            coverArtPrepared = preparedCoverArtIds.length > 0;
        }
        await deletion.cleanupReferences('album', canonicalAlbumId);

        let deleteError: unknown;
        try {
            const removed = await deletion.deleteOwner(canonicalAlbumId, referenceRevision);
            if (removed.deletedCount !== 1) {
                deleteError = new Error(`Album ${canonicalAlbumId} could not be finalized.`);
            }
        } catch (error) {
            deleteError = error;
        }
        if (deleteError) {
            let current: any | null;
            try {
                current = await deletion.findOwner(canonicalAlbumId);
            } catch (confirmationError) {
                throw new AlbumDeletionOutcomeUnknownError(canonicalAlbumId, {
                    deleteError,
                    confirmationError
                });
            }
            if (current != null) throw deleteError;
        }
    } catch (error) {
        if (error instanceof AlbumDeletionOutcomeUnknownError) throw error;
        await albums.updateOne(
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
        if (usesLegacyCoverHooks) await deletion.finalizeCoverArt(album.coverArtId);
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
