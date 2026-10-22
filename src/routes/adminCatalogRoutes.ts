import express from 'express';
import multer from 'multer';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { adminCatalogKind, editAdminCatalogItem, editAdminPageItem, getAdminCatalogItem, getAdminPage, listAdminCatalog } from '../administration/catalog/adminCatalogService';
import { runRequestWork } from '../services/platform/serverLifecycleService';
import { adminCatalogArtwork, adminCatalogMedia } from '../administration/catalog/adminCatalogPreview';
import { getAdminCatalogAlbumTracks } from '../administration/catalog/adminCatalogAlbumTracks';
import { AdminImportError } from '../administration/import/adminImportContract';
import { asyncHandler, uploadConcurrencyLimit } from '../middleware/requestProtectionMiddleware';
import { maxImageUploadMb } from '../middleware/imageUpload';
import { requireUploadSize } from '../middleware/audioUpload';
import { maxCoverArtInputBytes } from '../services/image/imageStorageService';
import { defaultImportObjectStorage } from '../administration/import/adminImportStorage';
import { catalogCoverUploadPreflight, uploadAdminCatalogCover } from '../administration/catalog/adminCatalogCoverUpload';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';
import { replaceAdminCatalogCover, clearAdminCatalogCover, listAdminCatalogCoverOperations, reconcileAdminCatalogCover, cancelAdminCatalogCover, type AdminCatalogCoverDependencies } from '../administration/catalog/adminCatalogCoverService';

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

/** Private edits have independent role, body-size, viewer and response boundaries; tests inject cover storage and cleanup. */
export const createAdminCatalogRouter = (dependencies: AdminCatalogCoverDependencies = {}) => {
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
    router.get('/catalog/album/:id/tracks', asyncHandler(run((actor, req) => getAdminCatalogAlbumTracks(actor, req.params.id))));
    router.patch('/catalog/:kind/:id', asyncHandler(run((actor, req) => editAdminCatalogItem(actor, adminCatalogKind(req.params.kind), req.params.id, req.body))));
    router.post('/catalog/:kind/:id/cover', asyncHandler(run((actor, req) => replaceAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.body, dependencies))));
    router.delete('/catalog/:kind/:id/cover', asyncHandler(run((actor, req) => clearAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.body, dependencies))));
    const coverUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: maxCoverArtInputBytes, fields: 0, parts: 1 } }).single('file');
    // Item and intent are checked before upload capacity or body parsing; only one size-capped image part is read into memory.
    router.post('/catalog/:kind/:id/cover-uploads', (req, res, next) => {
        try { catalogCoverUploadPreflight(req.params.kind, req.params.id, req.get('Idempotency-Key')); next(); }
        catch (error: any) { res.status(Number.isInteger(error?.statusCode) ? error.statusCode : 400).json({ code: typeof error?.code === 'string' ? error.code : 'ADMIN_CATALOG_INVALID_INPUT' }); }
    }, uploadConcurrencyLimit, requireUploadSize(maxImageUploadMb + 1), (req, res, next) => {
        void runRequestWork(req, () => new Promise<void>((resolve, reject) => { const aborted = () => reject(new Error('Aborted')); req.once('aborted', aborted); coverUpload(req, res, error => { req.off('aborted', aborted); error ? reject(error) : resolve(); }); }))
            .then(() => next()).catch((error: any) => { if (res.destroyed) return; const tooLarge = error?.code === 'LIMIT_FILE_SIZE'; res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'ADMIN_CATALOG_COVER_TOO_LARGE' : 'ADMIN_CATALOG_INVALID_INPUT' }); });
    }, asyncHandler(run((actor, req) => uploadAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.get('Idempotency-Key'), req.file, dependencies.storage ?? defaultImportObjectStorage))));
    router.get('/catalog/:kind/:id/cover-operations', asyncHandler(run((actor, req) => listAdminCatalogCoverOperations(actor, adminCatalogKind(req.params.kind), req.params.id))));
    router.post('/catalog/:kind/:id/cover-operations/:operationId/reconcile', asyncHandler(run((actor, req) => reconcileAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.params.operationId, dependencies))));
    router.post('/catalog/:kind/:id/cover-operations/:operationId/cancel', asyncHandler(run((actor, req) => cancelAdminCatalogCover(actor, adminCatalogKind(req.params.kind), req.params.id, req.params.operationId, req.body, dependencies))));
    router.get('/catalog/:kind/:id/artwork', limitMediaConcurrencyFor('artwork'), asyncHandler(adminCatalogArtwork));
    router.get('/catalog/audioTrack/:id/media', limitMediaConcurrencyFor('playback'), asyncHandler(adminCatalogMedia));
    router.get('/pages/:slug', asyncHandler(run((actor, req) => getAdminPage(actor, req.params.slug))));
    router.patch('/pages/:slug/items/:itemId', asyncHandler(run((actor, req) => editAdminPageItem(actor, req.params.slug, req.params.itemId, req.body))));
    return router;
};
