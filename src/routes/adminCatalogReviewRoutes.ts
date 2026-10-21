import express from 'express';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';
import { runRequestWork } from '../services/platform/serverLifecycleService';
import { AdminImportError } from '../administration/import/adminImportContract';
import { createCatalogReview, listCatalogReviews, getCatalogReview, editCatalogReview, analyzeCatalogReview, adoptCatalogReview, cancelCatalogReviewAnalysis, applyCatalogReview } from '../administration/catalog/adminCatalogReviewService';

/** Catalog proofreading has an independent private protocol; old import routes never accept its project IDs. */
export function createAdminCatalogReviewRouter() {
    const router = express.Router();
    router.use('/catalog-reviews', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.use('/catalog-reviews', requireAuth, requireAdmin, requireCurrentAccountViewer);
    // A save carries each changed value and its base, so up to two copies of a 48 KB draft (as an import field save); every other
    // body stays at 96 KB.
    const json = express.json({ limit: '96kb', strict: true }), fieldSaveJson = express.json({ limit: '160kb', strict: true });
    router.use('/catalog-reviews', (req, res, next) => (req.method === 'PATCH' && /^\/[^/]+\/?$/.test(req.path) ? fieldSaveJson : json)(req, res, next));
    const run = (handler: (actor: string, req: express.Request) => Promise<unknown>, status = 200): express.RequestHandler => async (req, res) => {
        try {
            const value = await runRequestWork(req, () => handler((req as AuthenticatedRequest).auth!.userId, req));
            if (!res.destroyed) res.status(status).json(value);
        } catch (error) {
            const known = error instanceof AdminImportError;
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'ADMIN_CATALOG_REVIEW_UNAVAILABLE' });
        }
    };
    router.get('/catalog-reviews', asyncHandler(run((actor, req) => listCatalogReviews(actor, req.query))));
    router.post('/catalog-reviews', asyncHandler(run((actor, req) => createCatalogReview(actor, req.body), 201)));
    router.get('/catalog-reviews/:id', asyncHandler(run((actor, req) => getCatalogReview(actor, req.params.id))));
    router.patch('/catalog-reviews/:id', asyncHandler(run((actor, req) => editCatalogReview(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/analyze', asyncHandler(run((actor, req) => analyzeCatalogReview(actor, req.params.id, req.body), 202)));
    router.post('/catalog-reviews/:id/adopt', asyncHandler(run((actor, req) => adoptCatalogReview(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/cancel-analysis', asyncHandler(run((actor, req) => cancelCatalogReviewAnalysis(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/apply', asyncHandler(run((actor, req) => applyCatalogReview(actor, req.params.id, req.body))));
    return router;
}
