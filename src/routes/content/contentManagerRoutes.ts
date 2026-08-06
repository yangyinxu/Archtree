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
import { audioWithCoverArtUpload, imageUpload } from '../../middleware/imageUpload';
import {
    attachRequestAbortSignal,
    uploadConcurrencyLimit,
    uploadRateLimit
} from '../../middleware/requestProtectionMiddleware';
import { maxImageUploadMb } from '../../middleware/imageUpload';

const router: Router = express.Router();

// Guard the entire manager surface before route-specific parsing, throttling, or uploads.
router.use(requireAuthForWeb, requireAdminForWeb);

router.get('/', contentController.renderManagePageForWeb);
router.get('/audio-tracks', contentController.renderAudioTracksPageForWeb);
router.get('/search', contentController.searchContentWeb);

router.post('/artist/create', uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createArtistWeb);
router.post('/artist/update', uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateArtistWeb);
router.post('/artist/delete', contentController.deleteArtistWeb);

router.post('/album/create', uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createAlbumWeb);
router.post('/album/update', uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAlbumWeb);
router.post('/album/delete', contentController.deleteAlbumWeb);
router.post('/album/delete-audio-tracks', contentController.deleteAlbumAudioTracksWeb);

router.post('/audioTrack/create', uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + maxImageUploadMb + 2), audioWithCoverArtUpload, contentController.createAudioTrackWeb);
router.post('/audioTrack/update', uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAudioTrackWeb);
router.post('/audioTrack/delete', contentController.deleteAudioTrackWeb);
router.post('/audioTrack/upload', uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), contentController.uploadAudioTrackWeb);
router.post('/audioTrack/bulk-upload', uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioBatchUploadMb), audioUpload.array('audioFiles', 20), contentController.bulkUploadAudioTracksWeb);

router.post('/link/track-album', contentController.linkTrackToAlbumWeb);
router.post('/link/album-artist', contentController.linkAlbumToArtistWeb);
router.post('/link/track-artist', contentController.linkTrackToArtistWeb);

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
