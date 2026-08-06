import express, { Router } from 'express';

import * as controller from '../../controllers/playlistController';
import { requireAuth, requireCurrentAccountViewer } from '../../middleware/authMiddleware';
import {
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
router.get('/me/playlists', controller.listPlaylists);
router.post('/me/playlists', playlistMutationConcurrencyLimit, controller.createPlaylist);
router.get('/me/playlists/memberships', controller.getPlaylistMemberships);
router.get('/me/playlists/:playlistId', controller.getPlaylist);
router.patch('/me/playlists/:playlistId', playlistMutationConcurrencyLimit, controller.renamePlaylist);
router.delete('/me/playlists/:playlistId', playlistMutationConcurrencyLimit, controller.deletePlaylist);
router.post('/me/playlists/:playlistId/items', playlistMutationConcurrencyLimit, controller.addPlaylistItem);
router.delete('/me/playlists/:playlistId/items/:itemId', playlistMutationConcurrencyLimit, controller.removePlaylistItem);
router.put('/me/playlists/:playlistId/items/order', playlistMutationConcurrencyLimit, controller.reorderPlaylistItems);

export default router;
