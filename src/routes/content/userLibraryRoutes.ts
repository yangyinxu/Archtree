import express, { Router } from 'express';
import * as controller from '../../controllers/userLibraryController';
import { requireAuth, requireCurrentAccountViewer } from '../../middleware/authMiddleware';
import { asyncHandler } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.use('/me', requireAuth, requireCurrentAccountViewer);
router.put('/me/saves/:contentType/:contentId', asyncHandler(controller.saveContent));
router.delete('/me/saves/:contentType/:contentId', asyncHandler(controller.unsaveContent));
router.post('/me/saves/status', asyncHandler(controller.getSaveStatuses));
router.get('/me/library', asyncHandler(controller.listLibrary));
router.post(
    '/me/recently-played',
    asyncHandler(controller.recordRecentlyPlayed)
);

export default router;
