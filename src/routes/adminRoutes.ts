import express, { Router } from 'express';

import {
    getAddProduct,
    getAudioStorageReconciliation,
    getImageStorageReconciliation,
    postAddProduct
} from '../controllers/adminController';
import { requireAdmin, requireAuth } from '../middleware/authMiddleware';

const router: Router = express.Router();

router.get('/product', getAddProduct);
router.post('/product', postAddProduct);
router.get('/audio-storage/reconciliation', requireAuth, requireAdmin, getAudioStorageReconciliation);
router.get('/image-storage/reconciliation', requireAuth, requireAdmin, getImageStorageReconciliation);

export default router;
