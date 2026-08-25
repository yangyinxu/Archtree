import express, { Router } from 'express';
import * as audioTrackController from '../../controllers/audioTrackController';
import { requireAdmin, requireAuth } from '../../middleware/authMiddleware';
import {
    audioUpload,
    cleanupTemporaryUploads,
    maxAudioUploadMb,
    requireUploadSize
} from '../../middleware/audioUpload';
import { audioWithCoverArtUpload, imageUpload, maxImageUploadMb } from '../../middleware/imageUpload';
import { maxVideoUploadMb, videoUpload } from '../../middleware/videoUpload';
import * as soundtrackVideoController from '../../controllers/soundtrackVideoController';
import * as mediaTrackController from '../../controllers/mediaTrackController';
import { limitMediaConcurrencyFor } from '../../middleware/mediaDeliveryMiddleware';
import { asyncHandler, attachRequestAbortSignal, publicReadRateLimit, uploadConcurrencyLimit } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.post('/audioTrack', requireAuth, requireAdmin, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + maxImageUploadMb + 2), audioWithCoverArtUpload, asyncHandler(audioTrackController.postAudioTrack));
router.put('/audioTrack/:audioTrackId', requireAuth, requireAdmin, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), imageUpload.single('coverArtFile'), asyncHandler(audioTrackController.updateAudioTrack));
router.get('/audioTrack/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.getAudioTrackById);
router.post('/audioTrack/:audioTrackId/upload', requireAuth, requireAdmin, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxAudioUploadMb + 1), audioUpload.single('audioFile'), asyncHandler(audioTrackController.uploadAudioTrackFile));
router.post('/audioTrack/:audioTrackId/video', requireAuth, requireAdmin, uploadConcurrencyLimit, attachRequestAbortSignal, cleanupTemporaryUploads, requireUploadSize(maxVideoUploadMb + 1), videoUpload.single('videoFile'), asyncHandler(soundtrackVideoController.uploadSoundtrackVideoFile));
router.delete('/audioTrack/:audioTrackId/video', requireAuth, requireAdmin, asyncHandler(soundtrackVideoController.deleteSoundtrackVideoFile));
router.delete('/audioTrack/:audioTrackId', requireAuth, requireAdmin, asyncHandler(audioTrackController.deleteAudioTrack));
router.get('/audioTrack/aws/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.getAudioFile);
router.head('/mediaTrack/stream/:mediaTrackId', limitMediaConcurrencyFor('playback'), mediaTrackController.headMediaTrack);
router.get('/mediaTrack/stream/:mediaTrackId', limitMediaConcurrencyFor('playback'), mediaTrackController.streamMediaTrack);
router.head('/audioTrack/download/:audioTrackId', requireAuth, limitMediaConcurrencyFor('download'), audioTrackController.headAudioTrackDownload);
router.get('/audioTrack/download/:audioTrackId', requireAuth, limitMediaConcurrencyFor('download'), audioTrackController.downloadAudioTrack);
router.head('/audioTrack/stream/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.headAudioTrackStream);
router.get('/audioTrack/stream/:audioTrackId', limitMediaConcurrencyFor('playback'), audioTrackController.streamAudioTrack);
router.head('/audioTrack/video/:audioTrackId', limitMediaConcurrencyFor('video'), soundtrackVideoController.headSoundtrackVideo);
router.get('/audioTrack/video/:audioTrackId', limitMediaConcurrencyFor('video'), soundtrackVideoController.streamSoundtrackVideo);
router.get('/audioTracks', publicReadRateLimit, asyncHandler(audioTrackController.getAudioTracks));

export default router;
