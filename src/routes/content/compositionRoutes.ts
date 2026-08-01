import express, { Router } from 'express';
import * as pageController from '../../controllers/pageController';
import * as contentCollectionController from '../../controllers/contentCollectionController';
import { attachOptionalAuth, requireAuth } from '../../middleware/authMiddleware';
import { asyncHandler, publicReadRateLimit } from '../../middleware/requestProtectionMiddleware';

const router: Router = express.Router();

router.get('/pages', publicReadRateLimit, asyncHandler(pageController.listPages));
router.get('/pages/:slug', publicReadRateLimit, asyncHandler(pageController.getPageBySlug));
router.get('/pages/:slug(library)/expanded', publicReadRateLimit, requireAuth, asyncHandler(pageController.getExpandedPageBySlug));
router.get('/pages/:slug/expanded', publicReadRateLimit, attachOptionalAuth, asyncHandler(pageController.getExpandedPageBySlug));
router.post('/pages', requireAuth, pageController.upsertPage);
router.post('/pages/:slug/items/carousel', requireAuth, pageController.attachCarouselToPage);
router.delete('/pages/:slug/items/carousel/:carouselId', requireAuth, pageController.removeCarouselFromPage);
router.post('/pages/:slug/items/reorder', requireAuth, pageController.reorderPageItems);
router.post('/pages/:slug/items/collection', requireAuth, contentCollectionController.attachContentCollectionToPage);
router.delete('/pages/:slug/items/collection/:collectionId', requireAuth, contentCollectionController.removeContentCollectionFromPage);

router.get('/carousels', requireAuth, pageController.listCarouselsByUser);
router.post('/carousels', requireAuth, pageController.createCarousel);
router.put('/carousels/:carouselId/artist-config', requireAuth, pageController.updateArtistCarousel);
router.put('/carousels/:carouselId/personalized-config', requireAuth, pageController.updatePersonalizedCarousel);
router.patch('/carousels/:carouselId/name', requireAuth, pageController.renameManualCarousel);
router.post('/carousels/:carouselId/items', requireAuth, pageController.addCarouselItem);
router.post('/carousels/:carouselId/items/reorder', requireAuth, pageController.reorderCarouselItems);
router.post('/carousels/:sourceCarouselId/items/move', requireAuth, pageController.moveCarouselItemBetweenCarousels);
router.delete('/carousels/:carouselId', requireAuth, pageController.deleteCarousel);

router.get('/content-collections', requireAuth, contentCollectionController.listContentCollections);
router.post('/content-collections', requireAuth, contentCollectionController.createContentCollection);
router.post('/content-collections/:collectionId/items', requireAuth, contentCollectionController.addContentCollectionItem);
router.post('/content-collections/:collectionId/items/reorder', requireAuth, contentCollectionController.reorderContentCollectionItems);
router.delete('/content-collections/:collectionId', requireAuth, contentCollectionController.deleteContentCollection);

export default router;
