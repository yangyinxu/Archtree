import express, { Router } from 'express';

import {
    getAddProduct,
    getAudioStorageReconciliation,
    getImageStorageReconciliation,
    postAddProduct
} from '../controllers/adminController';
import { requireAdmin, requireAuth } from '../middleware/authMiddleware';
import {
    asyncHandler,
    publicReadRateLimit,
    reconciliationConcurrencyLimit
} from '../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/product', requireAuth, requireAdmin, publicReadRateLimit, asyncHandler(getAddProduct));
router.post('/product', requireAuth, requireAdmin, asyncHandler(postAddProduct));
router.get('/audio-storage/reconciliation', requireAuth, requireAdmin, reconciliationConcurrencyLimit, asyncHandler(getAudioStorageReconciliation));
router.get('/image-storage/reconciliation', requireAuth, requireAdmin, reconciliationConcurrencyLimit, asyncHandler(getImageStorageReconciliation));

export default router;
