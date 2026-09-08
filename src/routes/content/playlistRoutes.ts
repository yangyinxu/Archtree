import express, { Router } from 'express';

import * as controller from '../../controllers/playlistController';
import { requireAuth, requireCurrentAccountViewer } from '../../middleware/authMiddleware';
import {
    asyncHandler,
    playlistMutationConcurrencyLimit,
    playlistRateLimit
} from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.use(
    '/me/playlists',
    controller.setPlaylistPrivacyHeaders,
    controller.requirePlaylistFeature,
    playlistRateLimit,
    requireAuth,
    requireCurrentAccountViewer,
    controller.setPlaylistPrivacyHeaders
);
router.get('/me/playlists', asyncHandler(controller.listPlaylists));
router.post('/me/playlists', playlistMutationConcurrencyLimit, asyncHandler(controller.createPlaylist));
router.get('/me/playlists/memberships', asyncHandler(controller.getPlaylistMemberships));
router.get('/me/playlists/:playlistId', asyncHandler(controller.getPlaylist));
router.patch('/me/playlists/:playlistId', playlistMutationConcurrencyLimit, asyncHandler(controller.renamePlaylist));
router.delete('/me/playlists/:playlistId', playlistMutationConcurrencyLimit, asyncHandler(controller.deletePlaylist));
router.post('/me/playlists/:playlistId/items', playlistMutationConcurrencyLimit, asyncHandler(controller.addPlaylistItem));
router.delete('/me/playlists/:playlistId/items/:itemId', playlistMutationConcurrencyLimit, asyncHandler(controller.removePlaylistItem));
router.put('/me/playlists/:playlistId/items/order', playlistMutationConcurrencyLimit, asyncHandler(controller.reorderPlaylistItems));

export default router;
