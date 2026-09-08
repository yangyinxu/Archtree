import { ClientSession, ObjectId } from 'mongodb';
import { acquireCatalogDeletionLease, CatalogDeletionLeaseLostError } from './catalogDeletionLeaseService';

import { getDb } from '../infrastructure/database';
import { cleanupDeletedContentReferences } from './contentReferenceService';
import {
    finalizeCoverArtDeletion,
    finalizeOwnerCoverArtDeletions,
    prepareCoverArtDeletion,
    prepareOwnerCoverArtDeletions
} from './imageStorageService';

export interface AlbumDeletionDependencies {
    prepareCoverArt: (
        imageId: string | undefined | null,
        albumId: string
    ) => Promise<boolean>;
    deleteCoverArtObject?: (key: string) => Promise<void>;
    prepareOwnerCoverArt: (
        albumId: string,
        currentImageId: string | undefined | null
    ) => Promise<string[]>;
    cleanupReferences: typeof cleanupDeletedContentReferences;
    deleteOwner: (
        albumId: string,
        referenceRevision: number,
        session?: ClientSession
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
    deleteOwner: async (albumId, referenceRevision, session) => getDb()!.collection('albums').deleteOne({
        _id: ObjectId.createFromHexString(albumId),
        lifecycleStatus: 'deleting',
        referenceRevision
    }, { session }),
    findOwner: albumId => getDb()!.collection('albums').findOne({
        _id: ObjectId.createFromHexString(albumId)
    }),
    finalizeCoverArt: finalizeCoverArtDeletion,
    finalizeOwnerCoverArt: finalizeOwnerCoverArtDeletions
};

/** Retains a leased deletion receipt until both the owner and exact prepared assets are gone. */
export const deleteAlbumAndReferences = async (
    albumId: string,
    dependencies: Partial<AlbumDeletionDependencies> = {}
): Promise<AlbumDeletionResult> => {
    if (!/^[0-9a-f]{24}$/i.test(albumId)) {
        return { deleted: false, ownerDeleted: false, cleanupPending: false };
    }
    const canonicalId = ObjectId.createFromHexString(albumId).toHexString();
    const deletion = { ...defaultAlbumDeletionDependencies, ...dependencies };
    const usesLegacyCoverHooks = dependencies.prepareCoverArt !== undefined
        || dependencies.finalizeCoverArt !== undefined;
    const lease = await acquireCatalogDeletionLease('album', new ObjectId(canonicalId));
    if (!lease) return { deleted: false, ownerDeleted: false, cleanupPending: false };

    const owner = lease.owner;
    let preparedImageIds = lease.operation.preparedImageIds;
    const fencedImages = {
        updateAsset: lease.updateImage,
        ...(dependencies.deleteCoverArtObject ? { deleteObject: dependencies.deleteCoverArtObject } : {})
    };
    try {
        if (owner) {
            try {
                await lease.assertHeld();
                if (usesLegacyCoverHooks) {
                    const prepared = await deletion.prepareCoverArt(owner.coverArtId, canonicalId);
                    if (owner.coverArtId && !prepared) {
                        throw new Error('Cover-art lifecycle evidence is missing.');
                    }
                    preparedImageIds = prepared && owner.coverArtId ? [String(owner.coverArtId)] : [];
                } else {
                    preparedImageIds = dependencies.prepareOwnerCoverArt
                        ? await deletion.prepareOwnerCoverArt(canonicalId, owner.coverArtId)
                        : await prepareOwnerCoverArtDeletions('album', canonicalId, owner.coverArtId, fencedImages);
                }
                await lease.recordPreparedImages(preparedImageIds);
                await lease.assertHeld();
                await deletion.cleanupReferences('album', canonicalId);
                try {
                    const removed = await lease.runFenced((session) => deletion.deleteOwner(
                        canonicalId, lease.operation.referenceRevision, session
                    ));
                    if (removed.deletedCount !== 1) throw new CatalogDeletionLeaseLostError();
                } catch (deleteError) {
                    // A superseded worker must never finalize its predecessor's prepared evidence.
                    if (deleteError instanceof CatalogDeletionLeaseLostError) throw deleteError;
                    let current: any | null;
                    try {
                        current = await deletion.findOwner(canonicalId);
                    } catch (confirmationError) {
                        throw new AlbumDeletionOutcomeUnknownError(canonicalId, {
                            deleteError, confirmationError
                        });
                    }
                    if (current != null) throw deleteError;
                }
            } catch (error) {
                if (error instanceof AlbumDeletionOutcomeUnknownError) throw error;
                await lease.fail(error).catch(() => undefined);
                return { deleted: false, ownerDeleted: false, cleanupPending: true, cleanupError: error };
            }
        }

        try {
            if (!owner) {
                for (const image of await lease.imagesNeedingPreparationRetry(preparedImageIds)) {
                    await prepareCoverArtDeletion(String(image._id), {
                        ...fencedImages, expectedOwnerType: 'album', expectedOwnerId: canonicalId
                    });
                }
            }
            if (usesLegacyCoverHooks && dependencies.finalizeCoverArt) {
                await lease.runFenced(() => deletion.finalizeCoverArt(lease.operation.coverArtId));
                await lease.recordPreparedImages([]);
            } else if (dependencies.finalizeOwnerCoverArt) {
                await lease.runFenced(() => deletion.finalizeOwnerCoverArt(preparedImageIds));
                await lease.recordPreparedImages([]);
            } else {
                await lease.finalizeImages(preparedImageIds);
            }
            await lease.complete();
            return { deleted: true, ownerDeleted: true, cleanupPending: false };
        } catch (cleanupError) {
            await lease.fail(cleanupError).catch(() => undefined);
            return { deleted: true, ownerDeleted: true, cleanupPending: true, cleanupError };
        }
    } finally {
        await lease.stop();
    }
};
