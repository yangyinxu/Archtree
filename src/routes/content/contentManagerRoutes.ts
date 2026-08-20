import express, { Router } from 'express';
import * as contentController from '../../controllers/contentController';
import * as pageController from '../../controllers/pageController';
import { requireAdminForWeb, requireAuthForWeb } from '../../middleware/authMiddleware';
import {
    audioUpload,
    cleanupTemporaryUploads,
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
    attachRequestAbortSignal,
    contentManagerUploadRateLimit,
    uploadConcurrencyLimit,
} from '../../middleware/requestProtectionMiddleware';
import { maxImageUploadMb } from '../../middleware/imageUpload';
import { maxVideoUploadMb, videoUpload } from '../../middleware/videoUpload';

const router: Router = express.Router();
const maximumMediaUploadMb = Math.max(maxAudioUploadMb, maxVideoUploadMb);
const createMediaTrackUpload = mediaWithCoverArtUpload(maximumMediaUploadMb);

// Guard the entire manager surface before route-specific parsing, throttling, or uploads.
router.use(requireAuthForWeb, requireAdminForWeb);

router.get('/', contentController.renderManagePageForWeb);
router.get('/audio-tracks', contentController.renderAudioTracksPageForWeb);
router.get('/search', contentController.searchContentWeb);
router.get('/reference-search', contentController.searchManagementReferencesWeb);
router.post('/workflows/artist-release', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize((maxImageUploadMb * 2) + 1), artistReleaseImageUpload, contentController.createArtistReleaseWorkflowWeb);
router.post('/workflows/artist-release/retry', contentController.retryArtistReleaseWorkflowWeb);
router.post('/organization/create', contentController.createOrganizationWeb);
router.post('/organization/release/create', contentController.createOrganizationReleaseWeb);
router.post('/organization/update', contentController.updateOrganizationWeb);
router.post('/organization/delete', contentController.deleteOrganizationWeb);
router.post('/credits/add', contentController.addCatalogCreditWeb);
router.post('/credits/remove', contentController.removeCatalogCreditWeb);
router.post('/credits/update-role', contentController.updateCatalogCreditRoleWeb);
router.post('/credits/reorder', contentController.reorderCatalogCreditWeb);
router.post('/credits/mark-unknown', contentController.markCatalogAttributionUnknownWeb);

router.post('/artist/create', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createArtistWeb);
router.post('/artist/update', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateArtistWeb);
router.post('/artist/update-metadata', contentController.updateArtistMetadataWeb);
router.post('/artist/update-cover-art', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateArtistCoverArtWeb);
router.post('/artist/delete', contentController.deleteArtistWeb);

router.post('/album/create', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createAlbumWeb);
router.post('/album/update', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAlbumWeb);
router.post('/album/delete', contentController.deleteAlbumWeb);
router.post('/album/delete-audio-tracks', contentController.deleteAlbumAudioTracksWeb);

router.post('/audioTrack/create', contentManagerUploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maximumMediaUploadMb + maxImageUploadMb + 2), createMediaTrackUpload, contentController.createAudioTrackWeb);
router.post('/audioTrack/update', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAudioTrackWeb);
router.post('/audioTrack/delete', contentController.deleteAudioTrackWeb);
router.post('/audioTrack/upload', contentManagerUploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), contentController.uploadAudioTrackWeb);
router.post('/audioTrack/video-upload', contentManagerUploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxVideoUploadMb + 1), videoUpload.single('videoFile'), contentController.uploadSoundtrackVideoWeb);
router.post('/audioTrack/video-delete', contentController.deleteSoundtrackVideoWeb);
router.post('/audioTrack/bulk-upload', contentManagerUploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioBatchUploadMb), audioUpload.array('audioFiles', 20), contentController.bulkUploadAudioTracksWeb);

router.post('/link/track-album', contentController.linkTrackToAlbumWeb);
router.post('/link/album-artist', contentController.linkAlbumToArtistWeb);
router.post('/link/track-artist', contentController.linkTrackToArtistWeb);
router.post('/artist/albums/add', contentController.addArtistAlbumWeb);
router.post('/artist/albums/remove', contentController.removeArtistAlbumWeb);
router.post('/artist/albums/create', contentManagerUploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createArtistAlbumWeb);

router.post('/composition/page/save', pageController.createOrUpdatePageWeb);
router.post('/composition/page/attach-carousel', pageController.attachCarouselToPageWeb);
router.post('/composition/page/reorder-item', pageController.reorderPageItemsWeb);
router.post('/composition/page/detach-carousel', pageController.detachCarouselFromPageWeb);

router.post('/composition/carousel/create', pageController.createCarouselWeb);
router.post('/composition/carousel/update-artist', pageController.updateArtistCarouselWeb);
router.post('/composition/carousel/update-personalized', pageController.updatePersonalizedCarouselWeb);
router.post('/composition/carousel/rename-manual', pageController.renameManualCarouselWeb);
router.post('/composition/carousel/add-item', pageController.addCarouselItemWeb);
router.post('/composition/carousel/reorder-item', pageController.reorderCarouselItemsWeb);
router.post('/composition/carousel/move-item', pageController.moveCarouselItemBetweenCarouselsWeb);
router.post('/composition/carousel/delete', pageController.deleteCarouselWeb);

export default router;
