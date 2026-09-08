import type { Album } from '../../models/album';
import { deleteCoverArt } from '../../services/imageStorageService';

/** Artwork whose storage lifecycle is ready before the owner is published. */
export type UploadedCoverArt = { imageId: string; coverArtUrl: string };

/** Injectable persistence and compensation boundaries for deterministic failure verification. */
export interface NewAlbumPublicationDependencies {
    saveAlbum?: () => Promise<unknown>;
    deleteUploadedCoverArt?: (imageId: string, albumId: string) => Promise<void>;
}

/** Publishes a ready Album only after optional artwork is ready and attached in the insert. */
export const publishNewAlbum = async (
    album: Album,
    coverArt?: UploadedCoverArt,
    dependencies: NewAlbumPublicationDependencies = {}
) => {
    const albumId = album._id?.toHexString();
    if (!albumId) throw new Error('A server-generated Album ID is required before publication.');
    if (coverArt) {
        album.coverArtId = coverArt.imageId;
        album.coverArtUrl = coverArt.coverArtUrl;
    }

    try {
        return await (dependencies.saveAlbum ?? (() => album.save()))();
    } catch (error) {
        if (!coverArt || (error as any)?.outcomeUnknown) throw error;
        try {
            if (dependencies.deleteUploadedCoverArt) {
                await dependencies.deleteUploadedCoverArt(coverArt.imageId, albumId);
            } else {
                await deleteCoverArt(coverArt.imageId, {
                    expectedOwnerType: 'album',
                    expectedOwnerId: albumId
                });
            }
        } catch (cleanupError) {
            throw Object.assign(
                new Error('Album creation failed and uploaded cover-art cleanup requires reconciliation.'),
                {
                    statusCode: 503,
                    code: 'album_creation_cleanup_pending',
                    cleanupPending: true,
                    reconciliationRequired: true,
                    cause: { creationError: error, cleanupError }
                }
            );
        }
        throw error;
    }
};
