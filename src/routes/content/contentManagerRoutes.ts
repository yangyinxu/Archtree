import express, { Router } from 'express';
import * as contentController from '../../controllers/contentController';
import * as pageController from '../../controllers/pageController';
import { requireAuthForWeb } from '../../middleware/authMiddleware';
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

router.get('/', requireAuthForWeb, contentController.renderManagePageForWeb);
router.get('/audio-tracks', requireAuthForWeb, contentController.renderAudioTracksPageForWeb);
router.get('/search', requireAuthForWeb, contentController.searchContentWeb);

router.post('/artist/create', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createArtistWeb);
router.post('/artist/update', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateArtistWeb);
router.post('/artist/delete', requireAuthForWeb, contentController.deleteArtistWeb);

router.post('/album/create', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.createAlbumWeb);
router.post('/album/update', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAlbumWeb);
router.post('/album/delete', requireAuthForWeb, contentController.deleteAlbumWeb);
router.post('/album/delete-audio-tracks', requireAuthForWeb, contentController.deleteAlbumAudioTracksWeb);

router.post('/audioTrack/create', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + maxImageUploadMb + 2), audioWithCoverArtUpload, contentController.createAudioTrackWeb);
router.post('/audioTrack/update', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), contentController.updateAudioTrackWeb);
router.post('/audioTrack/delete', requireAuthForWeb, contentController.deleteAudioTrackWeb);
router.post('/audioTrack/upload', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), contentController.uploadAudioTrackWeb);
router.post('/audioTrack/bulk-upload', requireAuthForWeb, uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioBatchUploadMb), audioUpload.array('audioFiles', 20), contentController.bulkUploadAudioTracksWeb);

router.post('/link/track-album', requireAuthForWeb, contentController.linkTrackToAlbumWeb);
router.post('/link/album-artist', requireAuthForWeb, contentController.linkAlbumToArtistWeb);
router.post('/link/track-artist', requireAuthForWeb, contentController.linkTrackToArtistWeb);

router.post('/composition/page/save', requireAuthForWeb, pageController.createOrUpdatePageWeb);
router.post('/composition/page/attach-carousel', requireAuthForWeb, pageController.attachCarouselToPageWeb);
router.post('/composition/page/reorder-item', requireAuthForWeb, pageController.reorderPageItemsWeb);
router.post('/composition/page/detach-carousel', requireAuthForWeb, pageController.detachCarouselFromPageWeb);

router.post('/composition/carousel/create', requireAuthForWeb, pageController.createCarouselWeb);
router.post('/composition/carousel/update-artist', requireAuthForWeb, pageController.updateArtistCarouselWeb);
router.post('/composition/carousel/update-personalized', requireAuthForWeb, pageController.updatePersonalizedCarouselWeb);
router.post('/composition/carousel/rename-manual', requireAuthForWeb, pageController.renameManualCarouselWeb);
router.post('/composition/carousel/add-item', requireAuthForWeb, pageController.addCarouselItemWeb);
router.post('/composition/carousel/reorder-item', requireAuthForWeb, pageController.reorderCarouselItemsWeb);
router.post('/composition/carousel/move-item', requireAuthForWeb, pageController.moveCarouselItemBetweenCarouselsWeb);
router.post('/composition/carousel/delete', requireAuthForWeb, pageController.deleteCarouselWeb);

export default router;
