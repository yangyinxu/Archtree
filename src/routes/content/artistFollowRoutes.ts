import { Router } from 'express';
import * as controller from '../../controllers/artistFollowController';
import { requireAuth, requireCurrentAccountViewer } from '../../middleware/authMiddleware';
import { asyncHandler } from '../../middleware/requestProtectionMiddleware';

const router = Router();
router.use('/me/artist-follows', controller.privateArtistFollowResponse, requireAuth, requireCurrentAccountViewer);
router.post('/me/artist-follows/status', asyncHandler(controller.statuses));
router.put('/me/artist-follows/:artistId', asyncHandler(controller.follow));
router.delete('/me/artist-follows/:artistId', asyncHandler(controller.unfollow));
export default router;
