import express, { Router } from 'express';
import * as albumController from '../../controllers/albumController';
import * as artistController from '../../controllers/artistController';
import * as contentController from '../../controllers/contentController';
import { requireAuth } from '../../middleware/authMiddleware';
import { imageUpload } from '../../middleware/imageUpload';

const router: Router = express.Router();

router.get('/search', contentController.searchContent);

router.post('/album', requireAuth, imageUpload.single('coverArtFile'), albumController.postAlbum);
router.put('/album/:albumId', requireAuth, imageUpload.single('coverArtFile'), albumController.updateAlbum);
router.delete('/album/:albumId', requireAuth, albumController.deleteAlbum);
router.get('/album/:albumId', albumController.getAlbumById);
router.get('/albums', albumController.getAlbums);

router.post('/artist', requireAuth, imageUpload.single('coverArtFile'), artistController.postArtist);
router.put('/artist/:artistId', requireAuth, imageUpload.single('coverArtFile'), artistController.updateArtist);
router.delete('/artist/:artistId', requireAuth, artistController.deleteArtist);
router.get('/artist/:artistId', artistController.getArtistById);
router.get('/artists', artistController.getArtists);

export default router;
