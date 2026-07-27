import express, { Router, RequestHandler} from 'express';

import { getVideo, getVideoById } from '../controllers/videoController';
import { limitMediaConcurrency } from '../middleware/mediaDeliveryMiddleware';

const router: Router = express.Router();

router.get('/', limitMediaConcurrency, getVideo);

router.get('/:videoId', limitMediaConcurrency, getVideoById);

export default router;
