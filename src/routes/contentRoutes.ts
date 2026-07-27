import express, { Router } from 'express';
import audioRoutes from './content/audioRoutes';
import catalogRoutes from './content/catalogRoutes';
import compositionRoutes from './content/compositionRoutes';
import contentManagerRoutes from './content/contentManagerRoutes';
import * as imageController from '../controllers/imageController';

const router: Router = express.Router();

router.use('/manage', contentManagerRoutes);
router.get('/images/:imageId', imageController.getImage);
router.use(audioRoutes);
router.use(catalogRoutes);
router.use(compositionRoutes);

export default router;
