import express, { Router } from 'express';

import { getVideo, getVideoById } from '../controllers/videoController';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/', limitMediaConcurrencyFor('video'), asyncHandler(getVideo));

router.get('/:videoId', limitMediaConcurrencyFor('video'), asyncHandler(getVideoById));

export default router;
