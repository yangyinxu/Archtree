import express, { Router } from 'express';
import * as audioTrackController from '../../controllers/audioTrackController';
import { requireAuth } from '../../middleware/authMiddleware';
import {
    audioUpload,
    cleanupTemporaryUploads,
    maxAudioUploadMb,
    requireUploadSize
} from '../../middleware/audioUpload';
import { audioWithCoverArtUpload, imageUpload, maxImageUploadMb } from '../../middleware/imageUpload';
import { limitMediaConcurrencyFor } from '../../middleware/mediaDeliveryMiddleware';
import { asyncHandler, attachRequestAbortSignal, publicReadRateLimit, uploadConcurrencyLimit, uploadRateLimit } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.post('/audioTrack', requireAuth, uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + maxImageUploadMb + 2), audioWithCoverArtUpload, audioTrackController.postAudioTrack);
router.put('/audioTrack/:audioTrackId', requireAuth, uploadRateLimit, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), audioTrackController.updateAudioTrack);
router.get('/audioTrack/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.getAudioTrackById);
router.post('/audioTrack/:audioTrackId/upload', requireAuth, uploadRateLimit, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), audioTrackController.uploadAudioTrackFile);
router.delete('/audioTrack/:audioTrackId', requireAuth, audioTrackController.deleteAudioTrack);
router.get('/audioTrack/aws/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.getAudioFile);
router.head('/audioTrack/download/:audioTrackId', requireAuth, limitMediaConcurrencyFor('download'), audioTrackController.headAudioTrackDownload);
router.get('/audioTrack/download/:audioTrackId', requireAuth, limitMediaConcurrencyFor('download'), audioTrackController.downloadAudioTrack);
router.head('/audioTrack/stream/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.headAudioTrackStream);
router.get('/audioTrack/stream/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.streamAudioTrack);
router.get('/audioTracks', publicReadRateLimit, asyncHandler(audioTrackController.getAudioTracks));

export default router;
