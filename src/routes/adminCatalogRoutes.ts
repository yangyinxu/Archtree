import express from 'express';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { adminCatalogKind, editAdminCatalogItem, editAdminPageItem, getAdminCatalogItem, getAdminPage, listAdminCatalog } from '../administration/catalog/adminCatalogService';
import { runRequestWork } from '../services/platform/serverLifecycleService';
import { adminCatalogArtwork, adminCatalogMedia } from '../administration/catalog/adminCatalogPreview';
import { AdminImportError } from '../administration/import/adminImportContract';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';
import { replaceAdminCatalogCover, clearAdminCatalogCover, listAdminCatalogCoverOperations, reconcileAdminCatalogCover, cancelAdminCatalogCover } from '../administration/catalog/adminCatalogCoverService';

/** Media elements cannot send the viewer header; the non-secret viewer is still only a session fence. */
const requireAdminCatalogViewer: express.RequestHandler = (req, res, next) => {
    const preview = ['GET', 'HEAD'].includes(req.method) && /\/(artwork|media)$/.test(req.path);
    if (preview && req.query.viewer !== undefined) {
        if (typeof req.query.viewer !== 'string' || !/^[0-9a-f]{24}$/.test(req.query.viewer)
            || Object.keys(req.query).some(key => key !== 'viewer')) return res.status(400).end();
        if (req.query.viewer !== (req as AuthenticatedRequest).auth!.userId) return res.status(409).end();
        const header = req.get('X-Finitude-Account-Viewer');
        if (header && header !== req.query.viewer) return res.status(409).end();
        req.headers['x-finitude-account-viewer'] = req.query.viewer;
    }
    return requireCurrentAccountViewer(req, res, next);
};

/** Private edits have independent role, body-size, viewer and response boundaries. */
export const createAdminCatalogRouter = () => {
    const router = express.Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.use(requireAuth, requireAdmin, requireAdminCatalogViewer, express.json({ limit: '64kb', strict: true }));
    const run = (handler: (actor: string, req: express.Request) => Promise<unknown>): express.RequestHandler => async (req, res) => {
        try { res.json(await runRequestWork(req, () => handler((req as AuthenticatedRequest).auth!.userId, req))); }
        catch (error: any) {
            if (error instanceof AdminImportError) return res.status(400).json({ code: 'ADMIN_CATALOG_INVALID_INPUT' });
            res.status(Number.isInteger(error?.statusCode) ? error.statusCode : 503).json({ code: typeof error?.code === 'string' ? error.code : 'ADMIN_CATALOG_UNAVAILABLE' });
        }
    };
    router.get('/catalog/:kind', asyncHandler(run((actor, req) => listAdminCatalog(actor, adminCatalogKind(req.params.kind), req.query))));
    router.get('/catalog/:kind/:id', asyncHandler(run((actor, req) => getAdminCatalogItem(actor, adminCatalogKind(req.params.kind), req.params.id))));
    router.patch('/catalog/:kind/:id', asyncHandler(run((actor, req) => editAdminCatalogItem(actor, adminCatalogKind(req.params.kind), req.params.id, req.body))));
    router.post('/catalog/:kind/:id/cover', asyncHandler(run((actor, req) => replaceAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.body))));
    router.delete('/catalog/:kind/:id/cover', asyncHandler(run((actor, req) => clearAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.body))));
    router.get('/catalog/:kind/:id/cover-operations', asyncHandler(run((actor, req) => listAdminCatalogCoverOperations(actor, adminCatalogKind(req.params.kind), req.params.id))));
    router.post('/catalog/:kind/:id/cover-operations/:operationId/reconcile', asyncHandler(run((actor, req) => reconcileAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.params.operationId))));
    router.post('/catalog/:kind/:id/cover-operations/:operationId/cancel', asyncHandler(run((actor, req) => cancelAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.params.operationId, req.body))));
    router.get('/catalog/:kind/:id/artwork', limitMediaConcurrencyFor('artwork'), asyncHandler(adminCatalogArtwork));
    router.get('/catalog/audioTrack/:id/media', limitMediaConcurrencyFor('playback'), asyncHandler(adminCatalogMedia));
    router.get('/pages/:slug', asyncHandler(run((actor, req) => getAdminPage(actor, req.params.slug))));
    router.patch('/pages/:slug/items/:itemId', asyncHandler(run((actor, req) => editAdminPageItem(actor, req.params.slug, req.params.itemId, req.body))));
    return router;
};
