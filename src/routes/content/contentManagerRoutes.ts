import express, { Router } from 'express';
import * as contentController from '../../controllers/contentController';
import * as pageController from '../../controllers/pageController';
import { requireAdminForWeb, requireAuthForWeb } from '../../middleware/authMiddleware';
import {
    audioUpload,
    cleanupTemporaryUploads,
    maxAudioBatchFiles,
    maxAudioBatchUploadMb,
    maxAudioUploadMb,
    requireUploadSize
} from '../../middleware/audioUpload';
import {
    artistReleaseImageUpload,
    imageUpload,
    mediaWithCoverArtUpload
} from '../../middleware/imageUpload';
import {
    asyncHandler,
    attachRequestAbortSignal,
    uploadConcurrencyLimit,
} from '../../middleware/requestProtectionMiddleware';
import { maxImageUploadMb } from '../../middleware/imageUpload';
import { maxVideoUploadMb, videoUpload } from '../../middleware/videoUpload';

const router: Router = express.Router();
const maximumMediaUploadMb = Math.max(maxAudioUploadMb, maxVideoUploadMb);
const createMediaTrackUpload = mediaWithCoverArtUpload(maximumMediaUploadMb);

// Guard the entire manager surface before route-specific parsing, throttling, or uploads.
router.use(requireAuthForWeb, requireAdminForWeb);

router.get('/', asyncHandler(contentController.renderManagePageForWeb));
router.get('/audio-tracks', asyncHandler(contentController.renderAudioTracksPageForWeb));
router.get('/search', asyncHandler(contentController.searchContentWeb));
router.get('/reference-search', asyncHandler(contentController.searchManagementReferencesWeb));
router.post('/workflows/artist-release', uploadConcurrencyLimit, requireUploadSize((maxImageUploadMb * 2) + 1), artistReleaseImageUpload, asyncHandler(contentController.createArtistReleaseWorkflowWeb));
router.post('/workflows/artist-release/retry', asyncHandler(contentController.retryArtistReleaseWorkflowWeb));
router.post('/organization/create', asyncHandler(contentController.createOrganizationWeb));
router.post('/organization/release/create', asyncHandler(contentController.createOrganizationReleaseWeb));
router.post('/organization/update', asyncHandler(contentController.updateOrganizationWeb));
router.post('/organization/delete', asyncHandler(contentController.deleteOrganizationWeb));
router.post('/credits/add', asyncHandler(contentController.addCatalogCreditWeb));
router.post('/credits/remove', asyncHandler(contentController.removeCatalogCreditWeb));
router.post('/credits/update-role', asyncHandler(contentController.updateCatalogCreditRoleWeb));
router.post('/credits/reorder', asyncHandler(contentController.reorderCatalogCreditWeb));
router.post('/credits/mark-unknown', asyncHandler(contentController.markCatalogAttributionUnknownWeb));

router.post('/artist/create', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.createArtistWeb));
router.post('/artist/update', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.updateArtistWeb));
router.post('/artist/update-metadata', asyncHandler(contentController.updateArtistMetadataWeb));
router.post('/artist/update-cover-art', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.updateArtistCoverArtWeb));
router.post('/artist/delete', asyncHandler(contentController.deleteArtistWeb));

router.post('/album/create', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.createAlbumWeb));
router.post('/album/update', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.updateAlbumWeb));
router.post('/album/delete', asyncHandler(contentController.deleteAlbumWeb));
router.post('/album/delete-audio-tracks', asyncHandler(contentController.deleteAlbumAudioTracksWeb));

router.post('/audioTrack/create', uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maximumMediaUploadMb + maxImageUploadMb + 2), createMediaTrackUpload, asyncHandler(contentController.createAudioTrackWeb));
router.post('/audioTrack/update', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.updateAudioTrackWeb));
router.post('/audioTrack/delete', asyncHandler(contentController.deleteAudioTrackWeb));
router.post('/audioTrack/upload', uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), asyncHandler(contentController.uploadAudioTrackWeb));
router.post('/audioTrack/video-upload', uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxVideoUploadMb + 1), videoUpload.single('videoFile'), asyncHandler(contentController.uploadSoundtrackVideoWeb));
router.post('/audioTrack/video-delete', asyncHandler(contentController.deleteSoundtrackVideoWeb));
router.post('/audioTrack/bulk-upload', uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioBatchUploadMb), audioUpload.array('audioFiles', maxAudioBatchFiles), asyncHandler(contentController.bulkUploadAudioTracksWeb));

router.post('/link/track-album', asyncHandler(contentController.linkTrackToAlbumWeb));
router.post('/link/album-artist', asyncHandler(contentController.linkAlbumToArtistWeb));
router.post('/link/track-artist', asyncHandler(contentController.linkTrackToArtistWeb));
router.post('/artist/albums/add', asyncHandler(contentController.addArtistAlbumWeb));
router.post('/artist/albums/remove', asyncHandler(contentController.removeArtistAlbumWeb));
router.post('/artist/albums/create', uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(contentController.createArtistAlbumWeb));

router.post('/composition/page/save', asyncHandler(pageController.createOrUpdatePageWeb));
router.post('/composition/page/attach-carousel', asyncHandler(pageController.attachCarouselToPageWeb));
router.post('/composition/page/reorder-item', asyncHandler(pageController.reorderPageItemsWeb));
router.post('/composition/page/detach-carousel', asyncHandler(pageController.detachCarouselFromPageWeb));

router.post('/composition/carousel/create', asyncHandler(pageController.createCarouselWeb));
router.post('/composition/carousel/update-artist', asyncHandler(pageController.updateArtistCarouselWeb));
router.post('/composition/carousel/update-personalized', asyncHandler(pageController.updatePersonalizedCarouselWeb));
router.post('/composition/carousel/rename-manual', asyncHandler(pageController.renameManualCarouselWeb));
router.post('/composition/carousel/add-item', asyncHandler(pageController.addCarouselItemWeb));
router.post('/composition/carousel/reorder-item', asyncHandler(pageController.reorderCarouselItemsWeb));
router.post('/composition/carousel/move-item', asyncHandler(pageController.moveCarouselItemBetweenCarouselsWeb));
router.post('/composition/carousel/delete', asyncHandler(pageController.deleteCarouselWeb));

export default router;
