import express, { Router } from 'express';
import * as pageController from '../../controllers/pageController';
import * as contentCollectionController from '../../controllers/contentCollectionController';
import {
    attachOptionalAuth,
    requireAdmin,
    requireAuth,
    requireCurrentAccountViewer,
    requireCurrentAccountViewerWhenAuthenticated
} from '../../middleware/authMiddleware';
import { asyncHandler, publicReadRateLimit } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/pages', publicReadRateLimit, asyncHandler(pageController.listPages));
router.get('/pages/:slug', publicReadRateLimit, asyncHandler(pageController.getPageBySlug));
router.get(
    '/pages/:slug(library)/expanded',
    publicReadRateLimit,
    requireAuth,
    requireCurrentAccountViewer,
    asyncHandler(pageController.getExpandedPageBySlug)
);
router.get(
    '/pages/:slug/expanded',
    publicReadRateLimit,
    attachOptionalAuth,
    requireCurrentAccountViewerWhenAuthenticated,
    asyncHandler(pageController.getExpandedPageBySlug)
);
router.post('/pages', requireAuth, requireAdmin, asyncHandler(pageController.upsertPage));
router.post('/pages/:slug/items/carousel', requireAuth, requireAdmin, asyncHandler(pageController.attachCarouselToPage));
router.delete('/pages/:slug/items/carousel/:carouselId', requireAuth, requireAdmin, asyncHandler(pageController.removeCarouselFromPage));
router.post('/pages/:slug/items/reorder', requireAuth, requireAdmin, asyncHandler(pageController.reorderPageItems));
router.post('/pages/:slug/items/collection', requireAuth, requireAdmin, asyncHandler(contentCollectionController.attachContentCollectionToPage));
router.delete('/pages/:slug/items/collection/:collectionId', requireAuth, requireAdmin, asyncHandler(contentCollectionController.removeContentCollectionFromPage));

router.get('/carousels', requireAuth, requireAdmin, asyncHandler(pageController.listCarousels));
router.post('/carousels', requireAuth, requireAdmin, asyncHandler(pageController.createCarousel));
router.put('/carousels/:carouselId/artist-config', requireAuth, requireAdmin, asyncHandler(pageController.updateArtistCarousel));
router.put('/carousels/:carouselId/personalized-config', requireAuth, requireAdmin, asyncHandler(pageController.updatePersonalizedCarousel));
router.patch('/carousels/:carouselId/name', requireAuth, requireAdmin, asyncHandler(pageController.renameManualCarousel));
router.post('/carousels/:carouselId/items', requireAuth, requireAdmin, asyncHandler(pageController.addCarouselItem));
router.post('/carousels/:carouselId/items/reorder', requireAuth, requireAdmin, asyncHandler(pageController.reorderCarouselItems));
router.post('/carousels/:sourceCarouselId/items/move', requireAuth, requireAdmin, asyncHandler(pageController.moveCarouselItemBetweenCarousels));
router.delete('/carousels/:carouselId', requireAuth, requireAdmin, asyncHandler(pageController.deleteCarousel));

router.get('/content-collections', requireAuth, requireAdmin, asyncHandler(contentCollectionController.listContentCollections));
router.post('/content-collections', requireAuth, requireAdmin, asyncHandler(contentCollectionController.createContentCollection));
router.post('/content-collections/:collectionId/items', requireAuth, requireAdmin, asyncHandler(contentCollectionController.addContentCollectionItem));
router.post('/content-collections/:collectionId/items/reorder', requireAuth, requireAdmin, asyncHandler(contentCollectionController.reorderContentCollectionItems));
router.delete('/content-collections/:collectionId', requireAuth, requireAdmin, asyncHandler(contentCollectionController.deleteContentCollection));

export default router;
