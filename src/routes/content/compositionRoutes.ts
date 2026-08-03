import express, { Router } from 'express';
import * as pageController from '../../controllers/pageController';
import * as contentCollectionController from '../../controllers/contentCollectionController';
import { attachOptionalAuth, requireAdmin, requireAuth } from '../../middleware/authMiddleware';
import { asyncHandler, publicReadRateLimit } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/pages', publicReadRateLimit, asyncHandler(pageController.listPages));
router.get('/pages/:slug', publicReadRateLimit, asyncHandler(pageController.getPageBySlug));
router.get('/pages/:slug(library)/expanded', publicReadRateLimit, requireAuth, asyncHandler(pageController.getExpandedPageBySlug));
router.get('/pages/:slug/expanded', publicReadRateLimit, attachOptionalAuth, asyncHandler(pageController.getExpandedPageBySlug));
router.post('/pages', requireAuth, requireAdmin, pageController.upsertPage);
router.post('/pages/:slug/items/carousel', requireAuth, requireAdmin, pageController.attachCarouselToPage);
router.delete('/pages/:slug/items/carousel/:carouselId', requireAuth, requireAdmin, pageController.removeCarouselFromPage);
router.post('/pages/:slug/items/reorder', requireAuth, requireAdmin, pageController.reorderPageItems);
router.post('/pages/:slug/items/collection', requireAuth, requireAdmin, contentCollectionController.attachContentCollectionToPage);
router.delete('/pages/:slug/items/collection/:collectionId', requireAuth, requireAdmin, contentCollectionController.removeContentCollectionFromPage);

router.get('/carousels', requireAuth, requireAdmin, pageController.listCarousels);
router.post('/carousels', requireAuth, requireAdmin, pageController.createCarousel);
router.put('/carousels/:carouselId/artist-config', requireAuth, requireAdmin, pageController.updateArtistCarousel);
router.put('/carousels/:carouselId/personalized-config', requireAuth, requireAdmin, pageController.updatePersonalizedCarousel);
router.patch('/carousels/:carouselId/name', requireAuth, requireAdmin, pageController.renameManualCarousel);
router.post('/carousels/:carouselId/items', requireAuth, requireAdmin, pageController.addCarouselItem);
router.post('/carousels/:carouselId/items/reorder', requireAuth, requireAdmin, pageController.reorderCarouselItems);
router.post('/carousels/:sourceCarouselId/items/move', requireAuth, requireAdmin, pageController.moveCarouselItemBetweenCarousels);
router.delete('/carousels/:carouselId', requireAuth, requireAdmin, pageController.deleteCarousel);

router.get('/content-collections', requireAuth, requireAdmin, contentCollectionController.listContentCollections);
router.post('/content-collections', requireAuth, requireAdmin, contentCollectionController.createContentCollection);
router.post('/content-collections/:collectionId/items', requireAuth, requireAdmin, contentCollectionController.addContentCollectionItem);
router.post('/content-collections/:collectionId/items/reorder', requireAuth, requireAdmin, contentCollectionController.reorderContentCollectionItems);
router.delete('/content-collections/:collectionId', requireAuth, requireAdmin, contentCollectionController.deleteContentCollection);

export default router;
