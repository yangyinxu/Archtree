import express, { Router } from 'express';
import audioRoutes from './content/audioRoutes';
import catalogRoutes from './content/catalogRoutes';
import compositionRoutes from './content/compositionRoutes';
import contentManagerRoutes from './content/contentManagerRoutes';
import userLibraryRoutes from './content/userLibraryRoutes';
import * as imageController from '../controllers/imageController';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';

const router: Router = express.Router();

router.use('/manage', contentManagerRoutes);
router.use(userLibraryRoutes);
router.get('/images/:imageId', limitMediaConcurrencyFor('artwork'), imageController.getImage);
router.use(audioRoutes);
router.use(catalogRoutes);
router.use(compositionRoutes);

export default router;
