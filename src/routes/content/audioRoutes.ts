import express, { Router } from 'express';
import * as audioTrackController from '../../controllers/audioTrackController';
import { requireAuth } from '../../middleware/authMiddleware';
import { audioUpload } from '../../middleware/audioUpload';
import { audioWithCoverArtUpload, imageUpload } from '../../middleware/imageUpload';

const router: Router = express.Router();

router.post('/audioTrack', requireAuth, audioWithCoverArtUpload, audioTrackController.postAudioTrack);
router.put('/audioTrack/:audioTrackId', requireAuth, imageUpload.single('coverArtFile'), audioTrackController.updateAudioTrack);
router.get('/audioTrack/:audioTrackId', audioTrackController.getAudioTrackById);
router.post('/audioTrack/:audioTrackId/upload', requireAuth, audioUpload.single('audioFile'), audioTrackController.uploadAudioTrackFile);
router.delete('/audioTrack/:audioTrackId', requireAuth, audioTrackController.deleteAudioTrack);
router.get('/audioTrack/aws/:audioTrackId', audioTrackController.getAudioFile);
router.get('/audioTrack/stream/:audioTrackId', audioTrackController.streamAudioTrack);
router.get('/audioTracks', audioTrackController.getAudioTracks);

export default router;
