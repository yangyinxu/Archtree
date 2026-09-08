/** Adapts MediaTrack forms and per-file upload outcomes while retaining publication and cleanup evidence. */
import { logCatalogFailure } from '../catalogDiagnostics';
import { Request, Response, NextFunction } from 'express';
import { Album } from '../../models/album';
import { AudioTrack, AudioFormat } from '../../models/audioTrack';
import { SimpleDate } from '../../models/simpleDate';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../../utils/textEncoding';
import {
    embeddedTrackNumber,
    formatDuration,
    inferAudioFormat,
    readAudioMetadata,
    titleFromFileName
} from '../../services/audioMetadataService';
import {
    AudioStorageLifecycleError,
    deleteAudioObjectAndTrack,
    uploadAudioObject,
    uploadVideoObject
} from '../../services/audioStorageService';
import {
    InvalidSoundtrackVideoError,
    validateSoundtrackVideoFile
} from '../../services/videoMetadataService';
import { validateContentReferences } from '../../services/contentReferenceService';
import {
    attachCoverArtToNewOwner,
    updateCoverArtOwnerAndCleanup,
    uploadCoverArt
} from '../../services/imageStorageService';
import { getUploadedFile } from '../../middleware/imageUpload';
import { getRequestAbortSignal } from '../../middleware/requestProtectionMiddleware';
import { publishUploadedAudioTracks } from '../../services/albumTrackLinkService';
import { retryAudioTrackPublications } from '../../services/audioPublicationRecoveryService';
import {
    mergeLegacyArtistIdsIntoCredits,
    migratedCatalogCreditId,
    normalizeCatalogCredits
} from '../../models/catalogCredit';
import { addSoundtrackCredit, replaceCatalogCredits } from '../../services/catalogCreditService';
import {
    rejectNonAdminManagerRequest,
    redirectWithMessage,
    parseCsv,
    parseDateInput,
    getContentProvenanceId,
    respondToUploadError
} from './requestHelpers';
import { uniqueStrings, contentId } from '../../utils/catalogValues';

const proposedSoundtrackCredits = (
    audioTrackId: string,
    album: any | null,
    selectedArtistId: string,
    selectedRole: string,
    inheritAlbumPrimary: boolean,
    selectedOrganizationId: string = '',
    selectedOrganizationRole: string = 'label'
) => {
    const inherited = inheritAlbumPrimary && Array.isArray(album?.credits)
        ? album.credits.filter((credit: any) => credit?.subjectType === 'artist'
            && credit?.role === 'primary')
            .map((credit: any) => ({
                creditId: migratedCatalogCreditId(
                    'audioTrack', audioTrackId, 'artist', String(credit.subjectId), 'primary'
                ),
                subjectType: 'artist' as const,
                subjectId: String(credit.subjectId),
                role: 'primary' as const,
                order: 0
            }))
        : [];
    const role = ['primary', 'featured', 'performer', 'composer', 'producer', 'remixer'].includes(selectedRole)
        ? selectedRole as 'primary' | 'featured' | 'performer' | 'composer' | 'producer' | 'remixer'
        : 'primary';
    const selected = !selectedArtistId || inherited.some((credit: any) => credit.subjectId === selectedArtistId
        && credit.role === role)
        ? []
        : [{
            creditId: migratedCatalogCreditId(
                'audioTrack', audioTrackId, 'artist', selectedArtistId, role
            ),
            subjectType: 'artist' as const,
            subjectId: selectedArtistId,
            role,
            order: inherited.length
        }];
    const organizationRole = ['label', 'publisher', 'distributor', 'presenter'].includes(selectedOrganizationRole)
        ? selectedOrganizationRole as 'label' | 'publisher' | 'distributor' | 'presenter'
        : 'label';
    const organizationCredit = selectedOrganizationId
        ? [{
            creditId: migratedCatalogCreditId(
                'audioTrack',
                audioTrackId,
                'organization',
                selectedOrganizationId,
                organizationRole
            ),
            subjectType: 'organization' as const,
            subjectId: selectedOrganizationId,
            role: organizationRole,
            order: inherited.length + selected.length
        }]
        : [];
    return normalizeCatalogCredits([...inherited, ...selected, ...organizationCredit]);
};

/** Publishes validated uploaded media before an optional, separately retryable Album Credit promotion. */
export const createAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFile = getUploadedFile(req, 'mediaFile');
        if (!uploadFile) {
            return redirectWithMessage(res, 'An Audio or MP4 Video file is required to create a MediaTrack.');
        }
        const declaredContentType = String(uploadFile.mimetype ?? '').trim().toLowerCase();
        const mediaType = declaredContentType === 'video/mp4' ? 'video' : 'audio';
        if (mediaType === 'audio' && !declaredContentType.startsWith('audio/')) {
            return redirectWithMessage(res, 'MediaTrack files must be Audio or MP4 Video.');
        }
        const videoMetadata = mediaType === 'video'
            ? await validateSoundtrackVideoFile(uploadFile)
            : null;
        let audioMetadata: any = null;
        if (mediaType === 'audio') {
            try {
                audioMetadata = await readAudioMetadata(uploadFile);
            } catch (metadataError) {
                logCatalogFailure(res, 'audio_metadata_unavailable', metadataError);
            }
        }

        const artistId = String(req.body.artistId ?? '').trim();
        if (artistId) {
            const artistValidation = await validateContentReferences('artist', [artistId]);
            if (!artistValidation.valid) {
                return redirectWithMessage(res, artistValidation.message!);
            }
        }
        const organizationId = String(req.body.organizationId ?? '').trim();
        if (organizationId) {
            const organizationValidation = await validateContentReferences(
                'organization',
                [organizationId]
            );
            if (!organizationValidation.valid) {
                return redirectWithMessage(res, organizationValidation.message!);
            }
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return redirectWithMessage(res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
        }

        const formatType = String(req.body.formatType ?? (mediaType === 'video' ? 'MP4' : 'MP3'));
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
        const audioTrackObjectId = new ObjectId();
        const audioTrackId = audioTrackObjectId.toHexString();
        const originalFileName = normalizeUtf8Text(uploadFile.originalname);
        const artistRole = String(req.body.artistRole ?? 'primary');
        const inheritAlbumPrimary = req.body.inheritAlbumPrimaryCredits === 'true';
        const credits = proposedSoundtrackCredits(
            audioTrackId,
            album,
            artistId,
            artistRole,
            inheritAlbumPrimary,
            organizationId,
            String(req.body.organizationRole ?? 'label')
        );
        const attributionUnknown = req.body.attributionUnknown === 'true';
        if ((credits.length === 0) !== attributionUnknown) {
            return redirectWithMessage(
                res,
                credits.length === 0
                    ? 'Choose an Artist, Organization, inherited Album Artist, or mark attribution as not documented.'
                    : 'Attribution cannot be marked undocumented while Credits are selected.'
            );
        }
        const creditedArtistIds = [...new Set(credits
            .filter((credit) => credit.subjectType === 'artist')
            .map((credit) => credit.subjectId))];

        const track = new AudioTrack(
            normalizeUtf8Text(String(req.body.title ?? '')),
            creditedArtistIds as [string],
            parseCsv(String(req.body.genres ?? '')),
            albumId,
            parseDateInput(String(req.body.releaseDate ?? '')),
            String(req.body.duration ?? '')
                || formatDuration(videoMetadata?.durationSeconds),
            new AudioFormat(formatType, Number.isNaN(bitrate as number) ? undefined : bitrate),
            String(req.body.coverArtUrl ?? ''),
            authReq.auth.userId,
            originalFileName,
            uploadFile.mimetype || 'audio/mpeg',
            audioTrackObjectId
        );
        track.trackNumber = embeddedTrackNumber(audioMetadata?.common?.track?.no);
        track.credits = credits;
        track.attributionStatus = attributionUnknown ? 'unknown' : 'documented';
        track.creditRevision = 1;

        await track.save();
        const upload = mediaType === 'video'
            ? await uploadVideoObject(
                audioTrackId,
                uploadFile,
                getContentProvenanceId(track) || authReq.auth.userId,
                getRequestAbortSignal(req)
            )
            : await uploadAudioObject(
                audioTrackId,
                uploadFile,
                getContentProvenanceId(track) || authReq.auth.userId,
                getRequestAbortSignal(req)
            );
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            await attachCoverArtToNewOwner(audioTrackId, coverArt, {
                ownerType: 'audioTrack',
                updateOwner: (id, update) => AudioTrack.updateById(id, update),
                updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                    AudioTrack.updateCoverArtById(id, expectedImageId, update)
            });
        }

        await publishUploadedAudioTracks(albumId, [audioTrackId]);
        if (req.body.promoteToAlbumPrimary === 'true') {
            if (!albumId || !artistId || artistRole !== 'primary') {
                return redirectWithMessage(
                    res,
                    'MediaTrack published, but Album promotion requires a linked Album and Primary Artist role.'
                );
            }
            try {
                await addSoundtrackCredit(
                    audioTrackId,
                    {
                        creditId: migratedCatalogCreditId(
                            'audioTrack', audioTrackId, 'artist', artistId, 'primary'
                        ),
                        subjectType: 'artist',
                        subjectId: artistId,
                        role: 'primary',
                        order: 0
                    },
                    true,
                    1
                );
            } catch (promotionError) {
                return redirectWithMessage(
                    res,
                    (promotionError as any)?.outcomeUnknown
                        ? 'MediaTrack published, but Album promotion could not be confirmed. Run reconciliation before retrying from the Credit editor.'
                        : 'MediaTrack published with its MediaTrack Credit, but Album promotion did not complete. It remains safely MediaTrack-only and can be promoted from the Credit editor.'
                );
            }
        }

        return redirectWithMessage(
            res,
            upload.cleanupPending
                ? `${mediaType === 'video' ? 'Video' : 'Audio'} MediaTrack created successfully. Previous object cleanup will need to be retried.`
                : `${mediaType === 'video' ? 'Video' : 'Audio'} MediaTrack created successfully.`
        );
    } catch (error) {
        return next(error);
    }
};

/** Adapts combined media metadata and artwork changes to the existing fenced update operation. */
export const updateAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'MediaTrack ID is not valid.');
        }
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'MediaTrack not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        let requestedAlbumId: string | undefined;
        let requestedArtistIds: string[] | undefined;
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        const removeCoverArt = !coverArtFile && req.body.removeCoverArt === 'true';
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.artistIds) {
            const validation = await validateContentReferences(
                'artist',
                parseCsv(String(req.body.artistIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            requestedArtistIds = validation.ids;
        }
        if (req.body.genres) updatePayload.genres = parseCsv(String(req.body.genres));
        if (req.body.albumId !== undefined) {
            const albumId = String(req.body.albumId ?? '').trim();
            if (albumId) {
                const validation = await validateContentReferences('album', [albumId]);
                if (!validation.valid) return redirectWithMessage(res, validation.message!);
                requestedAlbumId = validation.ids[0];
            } else {
                requestedAlbumId = '';
            }
        }
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (req.body.duration) updatePayload.duration = String(req.body.duration);
        if (req.body.formatType) {
            const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
            const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
            updatePayload.format = new AudioFormat(
                String(req.body.formatType),
                Number.isNaN(bitrate as number) ? undefined : bitrate
            );
        }
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
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

        const cleanup = Object.keys(updatePayload).length > 0 || requestedAlbumId !== undefined
            ? await updateCoverArtOwnerAndCleanup(
                audioTrackId,
                updatePayload,
                track.coverArtId,
                removeCoverArt || Boolean(
                    replacementCoverArtId && track.coverArtId !== replacementCoverArtId
                ),
                {
                    ownerType: 'audioTrack',
                    updateOwner: requestedAlbumId === undefined
                        ? (id, update) => AudioTrack.updateById(id, update)
                        : (id, update) => AudioTrack.updateWithAlbumById(
                            id,
                            requestedAlbumId,
                            update
                        ),
                    updateOwnerIfCoverArtMatches: (id, expectedImageId, update) =>
                        requestedAlbumId === undefined
                            ? AudioTrack.updateCoverArtById(id, expectedImageId, update)
                            : AudioTrack.updateWithAlbumAndCoverArtById(
                                id,
                                requestedAlbumId,
                                expectedImageId,
                                update
                            )
                }
            )
            : { updateApplied: true, cleanupPending: false, cleanupError: undefined };
        if (cleanup.cleanupError) {
            logCatalogFailure(res, 'cover_art_cleanup_deferred', cleanup.cleanupError);
        }
        if (!cleanup.updateApplied) {
            return redirectWithMessage(
                res,
                cleanup.cleanupPending
                    ? 'MediaTrack was not updated because its cover-art lifecycle evidence requires reconciliation.'
                    : 'MediaTrack was not updated because its cover art changed concurrently.'
            );
        }
        if (requestedArtistIds) {
            const credits = mergeLegacyArtistIdsIntoCredits(
                'audioTrack',
                audioTrackId,
                track.credits,
                requestedArtistIds
            );
            await replaceCatalogCredits(
                'audioTrack',
                audioTrackId,
                credits,
                credits.length > 0 ? 'documented' : 'unknown',
                Number.isInteger(track.creditRevision) ? track.creditRevision : 0
            );
        }
        return redirectWithMessage(
            res,
            cleanup.cleanupPending
                ? 'MediaTrack updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'MediaTrack updated successfully.'
        );
    } catch (error) {
        return next(error);
    }
};

/** Runs the owned-storage deletion lifecycle before confirming MediaTrack removal. */
export const deleteAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'MediaTrack ID is not valid.');
        }
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'MediaTrack not found.');
        }

        try {
            const deletion = await deleteAudioObjectAndTrack(audioTrackId);
            return redirectWithMessage(
                res,
                deletion.cleanupPending
                    ? 'MediaTrack deleted successfully. Cover-art cleanup will need to be retried.'
                    : 'MediaTrack deleted successfully.'
            );
        } catch (s3Error) {
            logCatalogFailure(res, 'media_deletion_failed', s3Error);
            const outcomeUnknown = (s3Error as any)?.code === 'audio_deletion_outcome_unknown';
            return redirectWithMessage(
                res,
                outcomeUnknown
                    ? 'MediaTrack deletion outcome could not be confirmed. Reconciliation is required.'
                    : 'MediaTrack deletion could not complete. Track metadata was retained for retry and reconciliation.'
            );
        }
    } catch (error) {
        return next(error);
    }
};

/** Retains independent outcomes for every requested Album MediaTrack deletion. */
export const deleteAlbumAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const selectedTrackIds = uniqueStrings(
            Array.isArray(req.body.audioTrackIds)
                ? req.body.audioTrackIds.map(String)
                : req.body.audioTrackIds ? [String(req.body.audioTrackIds)] : []
        );
        if (!albumId || selectedTrackIds.length === 0) {
            return redirectWithMessage(res, 'Select at least one MediaTrack to delete.');
        }
        const maximumBatchDeletes = 100;
        if (selectedTrackIds.length > maximumBatchDeletes) {
            return redirectWithMessage(res, `Delete no more than ${maximumBatchDeletes} MediaTracks at once.`);
        }

        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);

        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const tracks = await Promise.all(selectedTrackIds.map((trackId) =>
            ObjectId.isValid(trackId) ? AudioTrack.findById(trackId) : Promise.resolve(null)
        ));
        const associatedTrackIds = new Set(uniqueStrings([
            ...(Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds.map(String) : []),
            ...tracks.filter(Boolean).filter((track: any) => String(track.albumId ?? '') === albumId).map(contentId)
        ]));
        const deletedTrackIds: string[] = [];
        const failedTrackIds: string[] = [];
        const outcomeUnknownTrackIds: string[] = [];
        const cleanupPendingTrackIds: string[] = [];
        for (const [index, trackId] of selectedTrackIds.entries()) {
            if (!tracks[index] || !associatedTrackIds.has(trackId)) {
                failedTrackIds.push(trackId);
                continue;
            }
            try {
                const deletion = await deleteAudioObjectAndTrack(trackId);
                deletedTrackIds.push(trackId);
                if (deletion.cleanupPending) cleanupPendingTrackIds.push(trackId);
            } catch (deleteError) {
                logCatalogFailure(res, 'media_deletion_failed', deleteError);
                failedTrackIds.push(trackId);
                if ((deleteError as any)?.code === 'audio_deletion_outcome_unknown') {
                    outcomeUnknownTrackIds.push(trackId);
                }
            }
        }

        if (failedTrackIds.length > 0) {
            return redirectWithMessage(
                res,
                `${deletedTrackIds.length} MediaTrack(s) deleted. ${failedTrackIds.length} could not be deleted.${outcomeUnknownTrackIds.length > 0 ? ` ${outcomeUnknownTrackIds.length} deletion outcome(s) require reconciliation.` : ' Failed MediaTracks remain recorded for retry and reconciliation.'}${cleanupPendingTrackIds.length > 0 ? ` ${cleanupPendingTrackIds.length} deleted MediaTrack(s) still require cover-art lifecycle cleanup.` : ''}`
            );
        }
        if (cleanupPendingTrackIds.length > 0) {
            return redirectWithMessage(
                res,
                `${deletedTrackIds.length} MediaTrack(s) deleted. ${cleanupPendingTrackIds.length} still require cover-art lifecycle cleanup.`
            );
        }

        return redirectWithMessage(res, `${deletedTrackIds.length} MediaTrack(s) deleted successfully.`);
    } catch (error) {
        return next(error);
    }
};

interface WebAudioTrackUploadDependencies {
    findTrack: typeof AudioTrack.findById;
    uploadObject: typeof uploadAudioObject;
    retryPublications: typeof retryAudioTrackPublications;
}

const defaultWebAudioTrackUploadDependencies: WebAudioTrackUploadDependencies = {
    findTrack: AudioTrack.findById.bind(AudioTrack),
    uploadObject: uploadAudioObject,
    retryPublications: retryAudioTrackPublications
};

const publicationStatusForMessage = (value: string) => value === '' ? 'empty' : value;

/** Keeps the one-file Content Manager result aligned with persisted publication state. */
export const uploadAudioTrackWeb = async (
    req: Request,
    res: Response,
    next: NextFunction,
    dependencyOverrides: Partial<WebAudioTrackUploadDependencies> = {}
) => {
    try {
        const dependencies = {
            ...defaultWebAudioTrackUploadDependencies,
            ...dependencyOverrides
        };
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        if (!ObjectId.isValid(audioTrackId)
            || String(new ObjectId(audioTrackId)) !== audioTrackId.toLowerCase()) {
            return redirectWithMessage(res, 'MediaTrack ID is not valid.');
        }
        const track = await dependencies.findTrack(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'MediaTrack not found.');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'Missing audio file.');
        }

        const upload = await dependencies.uploadObject(
            audioTrackId,
            uploadFile,
            getContentProvenanceId(track) || authReq.auth.userId,
            getRequestAbortSignal(req)
        );
        const publication = await dependencies.retryPublications([audioTrackId]);
        const publicationResult = publication.results.find(
            (result) => result.audioTrackId === audioTrackId.toLowerCase()
        );
        if (!publicationResult) {
            return redirectWithMessage(
                res,
                'Audio file uploaded, but publication outcome could not be read back. Reconciliation is required.'
            );
        }
        if (publicationResult.outcome !== 'ready') {
            const publicationMessage = publicationResult.outcome === 'unknown'
                ? 'Audio file uploaded, but publication outcome could not be confirmed. Reconciliation is required.'
                : `Audio file uploaded, but publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}. Retry publication without uploading the file again.`;
            return redirectWithMessage(
                res,
                `${publicationMessage}${upload.cleanupPending ? ' Previous object cleanup also needs to be retried.' : ''}`
            );
        }

        return redirectWithMessage(
            res,
            upload.cleanupPending
                ? `Audio file uploaded successfully. Publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}. Previous object cleanup will need to be retried.`
                : `Audio file uploaded successfully. Publication status is ${publicationStatusForMessage(publicationResult.publicationStatus)}.`
        );
    } catch (error) {
        if ((error as any)?.cleanupPending !== undefined) {
            return redirectWithMessage(
                res,
                (error as any)?.outcomeUnknown
                    ? 'Audio upload outcome could not be confirmed. Reconciliation is required.'
                    : (error as any)?.cleanupPending
                        ? 'Audio upload failed and storage cleanup must be retried.'
                        : String((error as Error).message || 'Audio upload failed.')
            );
        }
        return next(error);
    }
};

/** Replaces the one active MediaTrack object with a validated MP4. */
export const uploadSoundtrackVideoWeb = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const audioTrackId = String(req.body.audioTrackId ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{24}$/.test(audioTrackId)) {
            return redirectWithMessage(res, 'MediaTrack ID is not valid.');
        }
        const track: any = await AudioTrack.findById(audioTrackId);
        if (!track) return redirectWithMessage(res, 'MediaTrack not found.');
        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) return redirectWithMessage(res, 'Missing MP4 video file.');
        await validateSoundtrackVideoFile(uploadFile);
        const result = await uploadVideoObject(
            audioTrackId,
            uploadFile,
            getContentProvenanceId(track) || authReq.auth.userId,
            getRequestAbortSignal(req)
        );
        return redirectWithMessage(
            res,
            result.cleanupPending
                ? 'MediaTrack is now Video. Previous media cleanup remains recorded for reconciliation.'
                : 'MediaTrack was replaced with Video successfully.'
        );
    } catch (error) {
        if (error instanceof InvalidSoundtrackVideoError) {
            return redirectWithMessage(res, String(error.message));
        }
        if (error instanceof AudioStorageLifecycleError) {
            return redirectWithMessage(
                res,
                error.statusCode < 500
                    ? error.message
                    : error.outcomeUnknown
                        ? 'Video replacement outcome could not be confirmed. Reconciliation is required.'
                        : 'Video replacement failed. Lifecycle evidence was retained for retry and reconciliation.'
            );
        }
        return next(error);
    }
};

/** Retains a compatibility handler while enforcing the one-required-media rule. */
export const deleteSoundtrackVideoWeb = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const audioTrackId = String(req.body.audioTrackId ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{24}$/.test(audioTrackId)) {
            return redirectWithMessage(res, 'MediaTrack ID is not valid.');
        }
        return redirectWithMessage(
            res,
            'A MediaTrack must keep one media object. Replace Video with Audio, or delete the MediaTrack.'
        );
    } catch (error) {
        return next(error);
    }
};

/** Preserves per-file upload, publication, cleanup, and optional Credit-promotion outcomes. */
export const bulkUploadAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFiles = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
        if (uploadFiles.length === 0) {
            return respondToUploadError(req, res, 'Select at least one audio file to upload.');
        }

        const artistId = String(req.body.artistId ?? '').trim();
        if (artistId) {
            const artistValidation = await validateContentReferences('artist', [artistId]);
            if (!artistValidation.valid) {
                return respondToUploadError(req, res, artistValidation.message!);
            }
        }
        const organizationId = String(req.body.organizationId ?? '').trim();
        if (organizationId) {
            const organizationValidation = await validateContentReferences(
                'organization',
                [organizationId]
            );
            if (!organizationValidation.valid) {
                return respondToUploadError(req, res, organizationValidation.message!);
            }
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return respondToUploadError(req, res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
        }
        const artistRole = String(req.body.artistRole ?? 'primary');
        if (req.body.promoteToAlbumPrimary === 'true'
            && (!albumId || !artistId || artistRole !== 'primary')) {
            return respondToUploadError(
                req,
                res,
                'Album promotion requires a linked Album and Primary Artist role.'
            );
        }
        const attributionUnknown = req.body.attributionUnknown === 'true';
        const inheritsAlbumPrimary = req.body.inheritAlbumPrimaryCredits === 'true'
            && Array.isArray(album?.credits)
            && album.credits.some((credit: any) => credit?.subjectType === 'artist'
                && credit?.role === 'primary');
        const hasProposedCredits = Boolean(artistId || organizationId || inheritsAlbumPrimary);
        if (hasProposedCredits === attributionUnknown) {
            return respondToUploadError(
                req,
                res,
                hasProposedCredits
                    ? 'Attribution cannot be marked undocumented while Credits are selected.'
                    : 'Choose an Artist, Organization, inherited Album Artist, or mark attribution as not documented.'
            );
        }

        const uploadedTrackIds: string[] = [];
        const outcomes: Array<{
            originalFileName: string;
            audioTrackId: string | null;
            uploadStatus: string;
            publicationStatus: string;
            cleanupPending: boolean;
            error: string | null;
        }> = [];
        const cleanupPendingTrackIds: string[] = [];
        let failedCleanupPendingCount = 0;

        for (const uploadFile of uploadFiles) {
            const originalFileName = normalizeUtf8Text(uploadFile.originalname);
            const isAudioFile = uploadFile.mimetype.startsWith('audio/')
                || uploadFile.mimetype === 'video/mp4'
                || uploadFile.mimetype === 'application/ogg';
            if (!isAudioFile) {
                outcomes.push({
                    originalFileName,
                    audioTrackId: null,
                    uploadStatus: 'rejected',
                    publicationStatus: 'notAttempted',
                    cleanupPending: false,
                    error: 'The selected file is not a supported audio type.'
                });
                continue;
            }

            let metadata: any = null;
            try {
                metadata = await readAudioMetadata(uploadFile);
            } catch (metadataError) {
                logCatalogFailure(res, 'audio_metadata_unavailable', metadataError);
            }

            const embeddedGenres = Array.isArray(metadata?.common?.genre) ? metadata.common.genre.map(String) : [];
            const releaseYear = Number(metadata?.common?.year);
            const bitrate = Number(metadata?.format?.bitrate);
            const audioTrackObjectId = new ObjectId();
            const audioTrackId = audioTrackObjectId.toHexString();
            const credits = proposedSoundtrackCredits(
                audioTrackId,
                album,
                artistId,
                artistRole,
                req.body.inheritAlbumPrimaryCredits === 'true',
                organizationId,
                String(req.body.organizationRole ?? 'label')
            );
            const creditedArtistIds = [...new Set(credits
                .filter((credit) => credit.subjectType === 'artist')
                .map((credit) => credit.subjectId))];
            const metadataTitle = normalizeUtf8Text(String(metadata?.common?.title ?? ''));
            const track = new AudioTrack(
                metadataTitle || titleFromFileName(originalFileName) || 'Untitled Track',
                creditedArtistIds as [string],
                embeddedGenres as unknown as [string],
                albumId,
                Number.isFinite(releaseYear) && releaseYear > 0 ? new SimpleDate(releaseYear, 1, 1) : new SimpleDate(),
                formatDuration(metadata?.format?.duration),
                new AudioFormat(
                    inferAudioFormat(originalFileName, uploadFile.mimetype, metadata?.format?.container),
                    Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : undefined
                ),
                '',
                authReq.auth.userId,
                originalFileName,
                uploadFile.mimetype || 'audio/mpeg',
                audioTrackObjectId
            );
            track.trackNumber = embeddedTrackNumber(metadata?.common?.track?.no);
            track.credits = credits;
            track.attributionStatus = attributionUnknown ? 'unknown' : 'documented';
            track.creditRevision = 1;

            try {
                await track.save();
                const upload = await uploadAudioObject(
                    audioTrackId,
                    uploadFile,
                    authReq.auth.userId,
                    getRequestAbortSignal(req)
                );
                uploadedTrackIds.push(audioTrackId);
                if (upload.cleanupPending) cleanupPendingTrackIds.push(audioTrackId);
                outcomes.push({
                    originalFileName,
                    audioTrackId,
                    uploadStatus: 'ready',
                    publicationStatus: 'pending',
                    cleanupPending: upload.cleanupPending,
                    error: null
                });
            } catch (uploadError) {
                logCatalogFailure(res, 'media_upload_failed', uploadError);
                if ((uploadError as any)?.cleanupPending) failedCleanupPendingCount += 1;
                outcomes.push({
                    originalFileName,
                    audioTrackId,
                    uploadStatus: (uploadError as any)?.outcomeUnknown ? 'unknown' : 'failed',
                    publicationStatus: 'notAttempted',
                    cleanupPending: Boolean((uploadError as any)?.cleanupPending),
                    error: String((uploadError as Error)?.message ?? 'Audio upload failed.').slice(0, 500)
                });
            }
        }

        const publication = uploadedTrackIds.length > 0
            ? await retryAudioTrackPublications(uploadedTrackIds)
            : { requestedCount: 0, readyCount: 0, failedCount: 0, results: [] };
        const publicationById = new Map(
            publication.results.map((result) => [result.audioTrackId, result] as const)
        );
        for (const outcome of outcomes) {
            if (!outcome.audioTrackId || outcome.uploadStatus !== 'ready') continue;
            const result = publicationById.get(outcome.audioTrackId);
            outcome.publicationStatus = result?.publicationStatus ?? 'failed';
            if (result?.outcome !== 'ready') outcome.error = result?.error ?? 'Publication failed.';
        }
        let promotionMessage = '';
        if (req.body.promoteToAlbumPrimary === 'true') {
            const promotedTrack = publication.results.find((result) => result.outcome === 'ready');
            if (promotedTrack) {
                const promotedOwner: any = await AudioTrack.findById(promotedTrack.audioTrackId);
                try {
                    await addSoundtrackCredit(
                        promotedTrack.audioTrackId,
                        {
                            creditId: migratedCatalogCreditId(
                                'audioTrack', promotedTrack.audioTrackId, 'artist', artistId, 'primary'
                            ),
                            subjectType: 'artist',
                            subjectId: artistId,
                            role: 'primary',
                            order: 0
                        },
                        true,
                        Number.isInteger(promotedOwner?.creditRevision)
                            ? promotedOwner.creditRevision
                            : 1
                    );
                } catch (promotionError) {
                    promotionMessage = (promotionError as any)?.outcomeUnknown
                        ? ' Album promotion could not be confirmed; run reconciliation before retrying.'
                        : ' Album promotion did not complete; published MediaTracks remain safely MediaTrack-only and can be promoted from the Credit editor.';
                }
            }
        }
        const cleanupPendingCount = cleanupPendingTrackIds.length + failedCleanupPendingCount;
        const uploadFailureCount = outcomes.filter((outcome) => outcome.uploadStatus !== 'ready').length;
        const publicationFailureCount = publication.failedCount;
        const itemSummary = outcomes
            .filter((outcome) => outcome.audioTrackId)
            .map((outcome) => `${outcome.audioTrackId}: upload=${outcome.uploadStatus}, publication=${outcome.publicationStatus}`)
            .join('; ');
        const message = `${uploadedTrackIds.length} Audio MediaTrack${uploadedTrackIds.length === 1 ? '' : 's'} uploaded; ${publication.readyCount} published.${uploadFailureCount > 0 ? ` ${uploadFailureCount} file${uploadFailureCount === 1 ? '' : 's'} failed upload validation or storage.` : ''}${publicationFailureCount > 0 ? ` ${publicationFailureCount} publication${publicationFailureCount === 1 ? '' : 's'} failed and can be retried without another upload.` : ''}${cleanupPendingCount > 0 ? ` ${cleanupPendingCount} upload${cleanupPendingCount === 1 ? '' : 's'} require storage reconciliation or cleanup.` : ''}${promotionMessage}${itemSummary ? ` ${itemSummary}` : ''}`;
        if (req.get('X-Requested-With') === 'XMLHttpRequest') {
            return res.status(uploadedTrackIds.length > 0 ? 200 : 422).json({
                message,
                uploadedCount: uploadedTrackIds.length,
                publishedCount: publication.readyCount,
                uploadFailureCount,
                publicationFailureCount,
                cleanupPendingCount,
                outcomes
            });
        }
        return redirectWithMessage(res, message);
    } catch (error) {
        return next(error);
    }
};
