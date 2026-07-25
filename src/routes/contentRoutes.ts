import express, { Router } from 'express';

import * as audioTrackController from '../controllers/audioTrackController';
import * as albumController from '../controllers/albumController';
import * as artistController from '../controllers/artistController';

const router: Router = express.Router();

// ----------------------------
// Post data of an audio track
router.post('/audioTrack', audioTrackController.postAudioTrack);

// Get one audio track by id
router.get('/audioTrack/:audioTrackId', audioTrackController.getAudioTrackById);

// Delete an audio track by id
router.delete('/audioTrack/:audioTrackId', audioTrackController.deleteAudioTrack);

// Get an audio file from AWS by audio track id
router.get('/audioTrack/aws/:audioTrackId', audioTrackController.getAudioFile);

// ----------------------------
// Stream an audio track by id
router.get('/audioTrack/stream/:audioTrackId', audioTrackController.streamAudioTrack);

// ----------------------------
// Get all audio tracks
router.get('/audioTracks', audioTrackController.getAudioTracks);

// ----------------------------
// Post data of an album
router.post('/album', albumController.postAlbum);

// Get one album by id
router.get('/album/:albumId', albumController.getAlbumById);

// Get all albums
router.get('/albums', albumController.getAlbums);

// ----------------------------
// Post an artist
router.post('/artist', artistController.postArtist);

// Get one artist by id
router.get('/artist/:artistId', artistController.getArtistById);

// Get all artists
router.get('/artists', artistController.getArtists);

export default router;