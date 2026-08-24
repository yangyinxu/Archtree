import express, { Router } from 'express';

import { createLocalizationController } from '../controllers/localizationController';
import { publicReadRateLimit } from '../middleware/requestProtectionMiddleware';
import { LocalizationService } from '../services/localizationService';

/** Publishes reviewed localization artifacts without exposing arbitrary filesystem paths. */
export const createLocalizationRouter = (generatedRoot?: string): Router => {
  const router = express.Router();
  const controller = createLocalizationController(new LocalizationService(generatedRoot));
  router.get('/manifest', publicReadRateLimit, controller.manifest);
  router.get('/bundles/:locale', publicReadRateLimit, controller.bundle);
  return router;
};

export default createLocalizationRouter();
