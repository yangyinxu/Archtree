/** Adapts Album publication, replacement, and deletion forms without splitting their lifecycle transactions. */
import { logCatalogFailure } from '../catalogDiagnostics';
import { Request, Response, NextFunction } from 'express';
import { Album } from '../../models/album';
import { AudioTrack } from '../../models/audioTrack';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { ObjectId } from 'mongodb';
import { validateContentReferences } from '../../services/contentReferenceService';
import {
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt,
    validateCoverArtFile
} from '../../services/imageStorageService';
import { getUploadedFile } from '../../middleware/imageUpload';
import { deleteAlbumAndReferences } from '../../services/albumLifecycleService';
import { linkReadyAudioTracksToAlbum } from '../../services/albumTrackLinkService';
import { publishNewAlbum } from '../../application/catalog/publishNewAlbum';
import { ensureAlbumPrimaryArtistCredit } from '../../services/catalogCreditService';
import {
    rejectNonAdminManagerRequest,
    parseCsv,
    redirectWithMessage,
    parseDateInput
} from './requestHelpers';

/** Publishes an Album through the same artwork compensation contract as the JSON API. */
export const createAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackIds = parseCsv(String(req.body.audioTrackIds ?? ''));
        const trackValidation = await validateContentReferences('audioTrack', audioTrackIds);
        if (!trackValidation.valid) {
            return redirectWithMessage(res, trackValidation.message!);
        }

        const albumObjectId = new ObjectId();
        const album = new Album(
            String(req.body.title ?? ''),
            String(req.body.coverArtUrl ?? ''),
            trackValidation.ids as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumObjectId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const albumId = albumObjectId.toHexString();
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'album',
                albumId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewAlbum(album, coverArt);
        return redirectWithMessage(res, 'Album created successfully.');
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                'Album creation outcome could not be confirmed. Reconciliation is required before retrying.'
            );
        }
        if ((error as any)?.code === 'album_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Album was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

/** Creates an Album from an Artist workspace and links it before reporting success. */
export const createArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    let artistId = '';
    let createdAlbumId = '';
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const title = String(req.body.title ?? '').trim();
        if (!title) return redirectWithMessage(res, 'Album title is required.');

        const albumObjectId = new ObjectId();
        createdAlbumId = albumObjectId.toHexString();
        const album = new Album(
            title,
            '',
            [] as unknown as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumObjectId
        );
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'album',
                createdAlbumId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewAlbum(album, coverArt);
        try {
            await ensureAlbumPrimaryArtistCredit(createdAlbumId, artistId);
        } catch (linkError) {
            return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(`Album ${createdAlbumId} was created, but its Artist link did not complete. Retry the link from this workspace; do not recreate the Album.`)}#artist-albums`);
        }
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent('Album created and linked to Artist successfully.')}#artist-albums`);
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                `Album creation outcome could not be confirmed${createdAlbumId ? ` for ${createdAlbumId}` : ''}. Reconciliation is required before retrying.`
            );
        }
        if ((error as any)?.code === 'album_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Album was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

/** Keeps combined artwork and track membership updates on the atomic Album mutation path. */
export const updateAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        const album = await Album.findReadyById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.audioTrackIds !== undefined) {
            const validation = await validateContentReferences(
                'audioTrack',
                parseCsv(String(req.body.audioTrackIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.audioTrackIds = validation.ids;
        }
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'album',
                albumId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (removeCoverArt) {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }

        const cleanup = await updateCoverArtOwnerAndCleanup(
            albumId,
            updatePayload,
            album.coverArtId,
            removeCoverArt || Boolean(
                replacementCoverArtId && album.coverArtId !== replacementCoverArtId
            ),
            {
                ownerType: 'album',
                updateOwner: (id, update) => Album.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Album.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (cleanup.cleanupError) {
            logCatalogFailure(res, 'cover_art_cleanup_deferred', cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'Album was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'Album was not updated because its cover art changed concurrently.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Album updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Album updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

/** Reports incomplete Album cleanup as retryable rather than removing its final evidence. */
export const deleteAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        if (!ObjectId.isValid(albumId)
            || String(new ObjectId(albumId)) !== albumId.toLowerCase()) {
            return redirectWithMessage(res, 'Album ID is not valid.');
        }
        // Resume any surviving cleanup receipt even after the Album itself is gone.
        const cleanup = await deleteAlbumAndReferences(albumId);
        if (!cleanup.ownerDeleted && !cleanup.cleanupPending) {
            return redirectWithMessage(res, 'Album not found.');
        }
        if (!cleanup.ownerDeleted) {
            return redirectWithMessage(
                res,
                'Album was retained for retry and lifecycle reconciliation.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Album deleted successfully. Cover-art cleanup will need to be retried.'
                : 'Album deleted successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [trackValidation, albumValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const album = await Album.findById(albumId);

        if (!track || !album) {
            return redirectWithMessage(res, 'Track or album not found.');
        }

        await linkReadyAudioTracksToAlbum(albumId, [audioTrackId]);

        return redirectWithMessage(res, 'Track linked to album successfully.');
    } catch (error) {
        return next(error);
    }
};
