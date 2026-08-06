import express, { Router } from 'express';

import { getVideo, getVideoById } from '../controllers/videoController';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';

const router: Router = express.Router();

router.get('/', limitMediaConcurrencyFor('video'), getVideo);

router.get('/:videoId', limitMediaConcurrencyFor('video'), getVideoById);

export default router;
