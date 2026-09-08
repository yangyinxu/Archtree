import express, { Router } from 'express';
import audioRoutes from './content/audioRoutes';
import catalogRoutes from './content/catalogRoutes';
import compositionRoutes from './content/compositionRoutes';
import contentManagerRoutes from './content/contentManagerRoutes';
import playlistRoutes from './content/playlistRoutes';
import userLibraryRoutes from './content/userLibraryRoutes';
import * as imageController from '../controllers/imageController';
import {
    limitMediaConcurrencyFor,
    observeMediaDeliveryFor
} from '../middleware/mediaDeliveryMiddleware';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.use('/manage', contentManagerRoutes);
router.use(playlistRoutes);
router.use(userLibraryRoutes);
router.get(
    '/images/:imageId/v1/:width.webp',
    observeMediaDeliveryFor('artwork'),
    asyncHandler(imageController.getImageVariant)
);
router.get('/images/:imageId', limitMediaConcurrencyFor('artwork'), asyncHandler(imageController.getImage));
router.use(audioRoutes);
router.use(catalogRoutes);
router.use(compositionRoutes);

export default router;
