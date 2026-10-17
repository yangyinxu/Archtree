import express, { Router } from 'express';

import { createLocalizationController } from '../controllers/localizationController';
import { publicReadRateLimit } from '../middleware/requestProtectionMiddleware';
import { LocalizationService } from '../services/platform/localizationService';

/** Publishes reviewed localization artifacts without exposing arbitrary filesystem paths. */
export const createLocalizationRouter = (generatedRoot?: string, compatibility: 'v1' | 'v2' = 'v1'): Router => {
  const router = express.Router();
  const controller = createLocalizationController(new LocalizationService(generatedRoot, compatibility));
  router.get('/manifest', publicReadRateLimit, controller.manifest);
  router.get('/bundles/:locale', publicReadRateLimit, controller.bundle);
  return router;
};

export default createLocalizationRouter();
