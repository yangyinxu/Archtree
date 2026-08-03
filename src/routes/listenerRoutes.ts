import express, { Router } from 'express';

import * as listenerController from '../controllers/listenerController';
import {
    attachOptionalAccessAuth,
    requireAuth
} from '../middleware/authMiddleware';
import {
    asyncHandler,
    publicReadRateLimit
} from '../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/home', publicReadRateLimit, attachOptionalAccessAuth, asyncHandler(listenerController.home));
router.get('/search', publicReadRateLimit, asyncHandler(listenerController.search));
router.get('/albums/:id', publicReadRateLimit, asyncHandler(listenerController.album));
router.get('/artists/:id', publicReadRateLimit, asyncHandler(listenerController.artist));
router.get('/tracks/:id', publicReadRateLimit, asyncHandler(listenerController.audioTrack));
router.get('/library', publicReadRateLimit, requireAuth, asyncHandler(listenerController.library));

export default router;
