import express, { Router } from 'express';

import * as songController from '../controllers/songController';
import * as albumController from '../controllers/albumController';
import * as artistController from '../controllers/artistController';

const router: Router = express.Router();

// ----------------------------
// Post data of a song
router.post('/song', songController.postSong);

// Get one song by id
router.get('/song/:songId', songController.getSongById);

// Delete a song by id
router.delete('/song/:songId', songController.deleteSong);

// ----------------------------
// Get all songs
router.get('/songs', songController.getSongs);

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