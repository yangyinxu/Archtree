import express, { Router } from 'express';
import multer from 'multer';

import * as audioTrackController from '../controllers/audioTrackController';
import * as albumController from '../controllers/albumController';
import * as artistController from '../controllers/artistController';
import * as contentController from '../controllers/contentController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAuthForWeb } from '../middleware/authMiddleware';

const router: Router = express.Router();
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 50 * 1024 * 1024 }
});

// ----------------------------
// Post data of an audio track
router.post('/audioTrack', requireAuth, audioTrackController.postAudioTrack);

// Update an audio track by id
router.put('/audioTrack/:audioTrackId', requireAuth, audioTrackController.updateAudioTrack);

// Get one audio track by id
router.get('/audioTrack/:audioTrackId', audioTrackController.getAudioTrackById);

router.post('/audioTrack/:audioTrackId/upload', requireAuth, upload.single('audioFile'), audioTrackController.uploadAudioTrackFile);

// Delete an audio track by id
router.delete('/audioTrack/:audioTrackId', requireAuth, audioTrackController.deleteAudioTrack);

// Get an audio file from AWS by audio track id
router.get('/audioTrack/aws/:audioTrackId', audioTrackController.getAudioFile);

// ----------------------------
// Stream an audio track by id
router.get('/audioTrack/stream/:audioTrackId', audioTrackController.streamAudioTrack);

// ----------------------------
// Get all audio tracks
router.get('/audioTracks', audioTrackController.getAudioTracks);

// Unified search across artists, albums, and tracks
router.get('/search', contentController.searchContent);

router.get('/manage', requireAuthForWeb, contentController.renderManagePageForWeb);
router.get('/manage/search', requireAuthForWeb, contentController.searchContentWeb);

router.post('/manage/artist/create', requireAuthForWeb, contentController.createArtistWeb);
router.post('/manage/artist/update', requireAuthForWeb, contentController.updateArtistWeb);
router.post('/manage/artist/delete', requireAuthForWeb, contentController.deleteArtistWeb);

router.post('/manage/album/create', requireAuthForWeb, contentController.createAlbumWeb);
router.post('/manage/album/update', requireAuthForWeb, contentController.updateAlbumWeb);
router.post('/manage/album/delete', requireAuthForWeb, contentController.deleteAlbumWeb);

router.post('/manage/audioTrack/create', requireAuthForWeb, contentController.createAudioTrackWeb);
router.post('/manage/audioTrack/update', requireAuthForWeb, contentController.updateAudioTrackWeb);
router.post('/manage/audioTrack/delete', requireAuthForWeb, contentController.deleteAudioTrackWeb);
router.post('/manage/audioTrack/upload', requireAuthForWeb, upload.single('audioFile'), contentController.uploadAudioTrackWeb);

// ----------------------------
// Post data of an album
router.post('/album', requireAuth, albumController.postAlbum);

// Update an album by id
router.put('/album/:albumId', requireAuth, albumController.updateAlbum);

// Delete an album by id
router.delete('/album/:albumId', requireAuth, albumController.deleteAlbum);

// Get one album by id
router.get('/album/:albumId', albumController.getAlbumById);

// Get all albums
router.get('/albums', albumController.getAlbums);

// ----------------------------
// Post an artist
router.post('/artist', requireAuth, artistController.postArtist);

// Update an artist by id
router.put('/artist/:artistId', requireAuth, artistController.updateArtist);

// Delete an artist by id
router.delete('/artist/:artistId', requireAuth, artistController.deleteArtist);

// Get one artist by id
router.get('/artist/:artistId', artistController.getArtistById);

// Get all artists
router.get('/artists', artistController.getArtists);

export default router;