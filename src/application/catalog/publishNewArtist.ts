import type { Artist } from '../../models/artist';
import { deleteCoverArt } from '../../services/imageStorageService';

/** Artwork whose storage lifecycle is ready before the owner is published. */
export type UploadedCoverArt = { imageId: string; coverArtUrl: string };

/** Injectable persistence and compensation boundaries for deterministic failure verification. */
export interface NewArtistPublicationDependencies {
    saveArtist?: () => Promise<unknown>;
    deleteUploadedCoverArt?: (imageId: string, artistId: string) => Promise<void>;
}

/** Publishes a ready Artist only after optional artwork is ready and attached in the insert. */
export const publishNewArtist = async (
    artist: Artist,
    coverArt?: UploadedCoverArt,
    dependencies: NewArtistPublicationDependencies = {}
) => {
    const artistId = artist._id?.toHexString();
    if (!artistId) throw new Error('A server-generated Artist ID is required before publication.');
    if (coverArt) {
        artist.coverArtId = coverArt.imageId;
        artist.coverArtUrl = coverArt.coverArtUrl;
    }

    try {
        return await (dependencies.saveArtist ?? (() => artist.save()))();
    } catch (error) {
        if (!coverArt || (error as any)?.outcomeUnknown) throw error;
        try {
            if (dependencies.deleteUploadedCoverArt) {
                await dependencies.deleteUploadedCoverArt(coverArt.imageId, artistId);
            } else {
                await deleteCoverArt(coverArt.imageId, {
                    expectedOwnerType: 'artist',
                    expectedOwnerId: artistId
                });
            }
        } catch (cleanupError) {
            throw Object.assign(
                new Error('Artist creation failed and uploaded cover-art cleanup requires reconciliation.'),
                {
                    statusCode: 503,
                    code: 'artist_creation_cleanup_pending',
                    cleanupPending: true,
                    reconciliationRequired: true,
                    cause: { creationError: error, cleanupError }
                }
            );
        }
        throw error;
    }
};
