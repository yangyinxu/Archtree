import express, { Router } from 'express';

import * as contentController from '../controllers/contentController';

const router: Router = express.Router();

// ----------------------------
// Post data of a song
router.post('/song', contentController.postSong);

// Get one song by id
router.get('/song/:songId', contentController.getSongById);

// Delete a song by id
router.delete('/song/:songId', contentController.deleteSong);

// ----------------------------
// Get all songs
router.get('/songs', contentController.getSongs);

export default router;