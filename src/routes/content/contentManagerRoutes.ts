import express, { Router } from 'express';
import * as contentController from '../../controllers/contentController';
import * as pageController from '../../controllers/pageController';
import { requireAuthForWeb } from '../../middleware/authMiddleware';
import { audioUpload } from '../../middleware/audioUpload';

const router: Router = express.Router();

router.get('/', requireAuthForWeb, contentController.renderManagePageForWeb);
router.get('/audio-tracks', requireAuthForWeb, contentController.renderAudioTracksPageForWeb);
router.get('/search', requireAuthForWeb, contentController.searchContentWeb);

router.post('/artist/create', requireAuthForWeb, contentController.createArtistWeb);
router.post('/artist/update', requireAuthForWeb, contentController.updateArtistWeb);
router.post('/artist/delete', requireAuthForWeb, contentController.deleteArtistWeb);

router.post('/album/create', requireAuthForWeb, contentController.createAlbumWeb);
router.post('/album/update', requireAuthForWeb, contentController.updateAlbumWeb);
router.post('/album/delete', requireAuthForWeb, contentController.deleteAlbumWeb);
router.post('/album/delete-audio-tracks', requireAuthForWeb, contentController.deleteAlbumAudioTracksWeb);

router.post('/audioTrack/create', requireAuthForWeb, audioUpload.single('audioFile'), contentController.createAudioTrackWeb);
router.post('/audioTrack/update', requireAuthForWeb, contentController.updateAudioTrackWeb);
router.post('/audioTrack/delete', requireAuthForWeb, contentController.deleteAudioTrackWeb);
router.post('/audioTrack/upload', requireAuthForWeb, audioUpload.single('audioFile'), contentController.uploadAudioTrackWeb);
router.post('/audioTrack/bulk-upload', requireAuthForWeb, audioUpload.array('audioFiles', 20), contentController.bulkUploadAudioTracksWeb);

router.post('/link/track-album', requireAuthForWeb, contentController.linkTrackToAlbumWeb);
router.post('/link/album-artist', requireAuthForWeb, contentController.linkAlbumToArtistWeb);
router.post('/link/track-artist', requireAuthForWeb, contentController.linkTrackToArtistWeb);

router.post('/composition/page/save', requireAuthForWeb, pageController.createOrUpdatePageWeb);
router.post('/composition/page/attach-carousel', requireAuthForWeb, pageController.attachCarouselToPageWeb);
router.post('/composition/page/reorder-item', requireAuthForWeb, pageController.reorderPageItemsWeb);
router.post('/composition/page/detach-carousel', requireAuthForWeb, pageController.detachCarouselFromPageWeb);

router.post('/composition/carousel/create', requireAuthForWeb, pageController.createCarouselWeb);
router.post('/composition/carousel/update-artist', requireAuthForWeb, pageController.updateArtistCarouselWeb);
router.post('/composition/carousel/rename-manual', requireAuthForWeb, pageController.renameManualCarouselWeb);
router.post('/composition/carousel/add-item', requireAuthForWeb, pageController.addCarouselItemWeb);
router.post('/composition/carousel/reorder-item', requireAuthForWeb, pageController.reorderCarouselItemsWeb);
router.post('/composition/carousel/move-item', requireAuthForWeb, pageController.moveCarouselItemBetweenCarouselsWeb);
router.post('/composition/carousel/delete', requireAuthForWeb, pageController.deleteCarouselWeb);

export default router;
