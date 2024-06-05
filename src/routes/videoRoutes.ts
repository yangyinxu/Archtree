import express, { Router, RequestHandler} from 'express';

import { getVideo, getVideoById } from '../controllers/videoController';

const router: Router = express.Router();

router.get('/', getVideo);

router.get('/:videoId', getVideoById);

export default router;