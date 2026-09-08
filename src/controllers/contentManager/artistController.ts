/** Adapts Artist metadata, artwork, and relationship forms to the existing fenced Catalog operations. */
import { logCatalogFailure } from '../catalogDiagnostics';
import { Request, Response, NextFunction } from 'express';
import { Artist } from '../../models/artist';
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
import { deleteArtistAndReferences } from '../../services/artistLifecycleService';
import { publishNewArtist } from '../../application/catalog/publishNewArtist';
import { replaceArtistAlbums } from '../../services/artistAlbumLinkService';
import {
    ensureAlbumPrimaryArtistCredit,
    removeAlbumPrimaryArtistCredit
} from '../../services/catalogCreditService';
import { createCatalogCreditId } from '../../models/catalogCredit';
import { addCatalogCredit } from '../../services/catalogCreditService';
import {
    rejectNonAdminManagerRequest,
    parseCsv,
    redirectWithMessage,
    parseDateInput
} from './requestHelpers';

/** Publishes an Artist through the same artwork compensation contract as the JSON API. */
export const createArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumIds = parseCsv(String(req.body.albumIds ?? ''));
        const albumValidation = await validateContentReferences('album', albumIds);
        if (!albumValidation.valid) {
            return redirectWithMessage(res, albumValidation.message!);
        }

        const artistObjectId = new ObjectId();
        const artist = new Artist(
            String(req.body.name ?? ''),
            parseDateInput(String(req.body.birthDate ?? '')),
            String(req.body.bio ?? ''),
            String(req.body.coverArtUrl ?? ''),
            albumValidation.ids as [string],
            authReq.auth.userId,
            artistObjectId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const artistId = artistObjectId.toHexString();
        let coverArt: { imageId: string; coverArtUrl: string } | undefined;
        if (coverArtFile) {
            coverArt = await uploadCoverArt(
                'artist',
                artistId,
                coverArtFile,
                authReq.auth.userId,
                { allowMissingOwner: true }
            );
        }
        await publishNewArtist(artist, coverArt);
        if (albumValidation.ids.length > 0) {
            await replaceArtistAlbums(artistId, albumValidation.ids);
        }
        return redirectWithMessage(res, 'Artist created successfully.');
    } catch (error) {
        if ((error as any)?.outcomeUnknown) {
            return redirectWithMessage(
                res,
                'Artist creation outcome could not be confirmed. Reconciliation is required before retrying.'
            );
        }
        if ((error as any)?.code === 'artist_creation_cleanup_pending') {
            return redirectWithMessage(
                res,
                'Artist was not created. Uploaded cover-art cleanup requires reconciliation.'
            );
        }
        return next(error);
    }
};

/** Applies the legacy combined Artist form through existing relationship and artwork fences. */
export const updateArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.name) updatePayload.name = String(req.body.name);
        if (req.body.bio) updatePayload.bio = String(req.body.bio);
        const requestedAlbumIds = req.body.albumIds !== undefined
            ? parseCsv(String(req.body.albumIds))
            : undefined;
        if (requestedAlbumIds) {
            const validation = await validateContentReferences('album', requestedAlbumIds);
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
        }
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'artist',
                artistId,
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
            artistId,
            updatePayload,
            artist.coverArtId,
            removeCoverArt || Boolean(
                replacementCoverArtId && artist.coverArtId !== replacementCoverArtId
            ),
            {
                ownerType: 'artist',
                updateOwner: (id, update) => Artist.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Artist.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (cleanup.cleanupError) {
            logCatalogFailure(res, 'cover_art_cleanup_deferred', cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'Artist was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'Artist was not updated because its cover art changed concurrently.'
            );
        }
        if (requestedAlbumIds) await replaceArtistAlbums(artistId, requestedAlbumIds);
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Artist updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Artist updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

/** Updates Artist text/date metadata without entering multipart upload capacity. */
export const updateArtistMetadataWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const validation = await validateContentReferences('artist', [artistId]);
        if (!validation.valid) return redirectWithMessage(res, validation.message!);
        const name = String(req.body.name ?? '').trim();
        if (!name) return redirectWithMessage(res, 'Artist name is required.');

        await Artist.updateById(artistId, {
            name,
            bio: String(req.body.bio ?? ''),
            birthDate: parseDateInput(String(req.body.birthDate ?? ''))
        });
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent('Artist details updated successfully.')}#artist-update-card`);
    } catch (error) {
        return next(error);
    }
};

/** Replaces or removes Artist cover art on the upload-protected route only. */
export const updateArtistCoverArtWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const validation = await validateContentReferences('artist', [artistId]);
        if (!validation.valid) return redirectWithMessage(res, validation.message!);
        const artist = await Artist.findReadyById(artistId);
        if (!artist) return redirectWithMessage(res, 'Artist not found.');

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (!coverArtFile && !removeCoverArt) {
            return redirectWithMessage(res, 'Choose replacement cover art or select Remove current cover art.');
        }
        const updatePayload: Record<string, unknown> = {};
        let replacementCoverArtId: string | undefined;
        if (coverArtFile) {
            const coverArt = await uploadCoverArt('artist', artistId, coverArtFile, authReq.auth.userId);
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else {
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }
        const cleanup = await updateCoverArtOwnerAndCleanup(
            artistId,
            updatePayload,
            artist.coverArtId,
            removeCoverArt || Boolean(replacementCoverArtId && artist.coverArtId !== replacementCoverArtId),
            {
                ownerType: 'artist',
                updateOwner: (id, update) => Artist.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    Artist.updateCoverArtById(id, expectedImageId, update)
            }
        );
        if (!cleanup.updateApplied) {
            return redirectWithMessage(res, cleanup.cleanupPending
                ? 'Artist cover art was not updated because lifecycle evidence requires reconciliation.'
                : 'Artist cover art changed concurrently.');
        }
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(cleanup.cleanupPending ? 'Artist cover art updated. Previous artwork cleanup requires reconciliation.' : 'Artist cover art updated successfully.')}#artist-update-card`);
    } catch (error) {
        return next(error);
    }
};

/** Reports completion only after the shared Artist deletion lifecycle has removed its owner. */
export const deleteArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        if (!ObjectId.isValid(artistId)
            || String(new ObjectId(artistId)) !== artistId.toLowerCase()) {
            return redirectWithMessage(res, 'Artist ID is not valid.');
        }
        // Resume any surviving cleanup receipt even after the Artist itself is gone.
        const cleanup = await deleteArtistAndReferences(artistId);
        if (!cleanup.ownerDeleted && !cleanup.cleanupPending) {
            return redirectWithMessage(res, 'Artist not found.');
        }
        if (!cleanup.ownerDeleted) {
            return redirectWithMessage(
                res,
                'Artist was retained for retry and lifecycle reconciliation.'
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'Artist deleted successfully. Cover-art cleanup will need to be retried.'
                : 'Artist deleted successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

export const linkAlbumToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [albumValidation, artistValidation] = await Promise.all([
            validateContentReferences('album', [albumId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        await ensureAlbumPrimaryArtistCredit(albumId, artistId);
        return redirectWithMessage(res, 'Album primary Artist Credit is linked.');
    } catch (error) {
        return next(error);
    }
};

/** Adds a named Album from the Artist workspace without invoking upload middleware. */
export const addArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const artistId = String(req.body.artistId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [artistValidation, albumValidation] = await Promise.all([
            validateContentReferences('artist', [artistId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        await ensureAlbumPrimaryArtistCredit(albumId, artistId);
        const message = 'Album primary Artist Credit is linked.';
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(message)}#artist-albums`);
    } catch (error) {
        return next(error);
    }
};

/** Removes only the selected Artist membership and preserves the Album record. */
export const removeArtistAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const artistId = String(req.body.artistId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [artistValidation, albumValidation] = await Promise.all([
            validateContentReferences('artist', [artistId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        await removeAlbumPrimaryArtistCredit(albumId, artistId);
        const message = 'Album primary Artist Credit removed. The Album and its MediaTracks were not deleted.';
        return res.redirect(`/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(artistId)}&message=${encodeURIComponent(message)}#artist-albums`);
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [trackValidation, artistValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const artist = await Artist.findById(artistId);

        if (!track || !artist) {
            return redirectWithMessage(res, 'Track or artist not found.');
        }

        await addCatalogCredit('audioTrack', audioTrackId, {
            creditId: createCatalogCreditId(),
            subjectType: 'artist',
            subjectId: artistId,
            role: 'legacyUnspecified',
            order: 0
        });

        return redirectWithMessage(res, 'MediaTrack Artist Credit linked successfully.');
    } catch (error) {
        return next(error);
    }
};
