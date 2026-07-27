import express, { Router } from 'express';
import * as albumController from '../../controllers/albumController';
import * as artistController from '../../controllers/artistController';
import * as contentController from '../../controllers/contentController';
import { requireAuth } from '../../middleware/authMiddleware';
import { imageUpload, maxImageUploadMb } from '../../middleware/imageUpload';
import { requireUploadSize } from '../../middleware/audioUpload';
import {
    asyncHandler,
    publicReadRateLimit,
    uploadConcurrencyLimit,
    uploadRateLimit
} from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/search', publicReadRateLimit, asyncHandler(contentController.searchContent));

router.post('/album', requireAuth, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(albumController.postAlbum));
router.put('/album/:albumId', requireAuth, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(albumController.updateAlbum));
router.delete('/album/:albumId', requireAuth, asyncHandler(albumController.deleteAlbum));
router.get('/album/:albumId', publicReadRateLimit, asyncHandler(albumController.getAlbumById));
router.get('/albums', publicReadRateLimit, asyncHandler(albumController.getAlbums));

router.post('/artist', requireAuth, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(artistController.postArtist));
router.put('/artist/:artistId', requireAuth, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(artistController.updateArtist));
router.delete('/artist/:artistId', requireAuth, asyncHandler(artistController.deleteArtist));
router.get('/artist/:artistId', publicReadRateLimit, asyncHandler(artistController.getArtistById));
router.get('/artists', publicReadRateLimit, asyncHandler(artistController.getArtists));

export default router;
