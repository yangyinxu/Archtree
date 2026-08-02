import express, { Router } from 'express';
import * as controller from '../../controllers/userLibraryController';
import { requireAuth } from '../../middleware/authMiddleware';
import { asyncHandler } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.put('/me/saves/:contentType/:contentId', requireAuth, asyncHandler(controller.saveContent));
router.delete('/me/saves/:contentType/:contentId', requireAuth, asyncHandler(controller.unsaveContent));
router.post('/me/saves/status', requireAuth, asyncHandler(controller.getSaveStatuses));
router.get('/me/library', requireAuth, asyncHandler(controller.listLibrary));
router.post('/me/recently-played', requireAuth, asyncHandler(controller.recordRecentlyPlayed));

export default router;
