import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminImportError, importEnabled, objectId, uuid } from '../administration/import/adminImportContract';
import { importPrivateStorageReady } from '../administration/import/adminImportMediaTypes';
import { createAdminImport, getAdminImport, listAdminImports, editAdminImport, analyzeAdminImport, adoptAdminImportSuggestions, decideAdminImportDuplicates, cancelAdminImportAnalysis, adminImportDuplicateCandidates } from '../administration/import/adminImportService';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { runRequestWork, onRequestWorkComplete } from '../services/platform/serverLifecycleService';
import { maxAudioUploadMb, requireUploadSize } from '../middleware/audioUpload';
import { cleanupAdminImportAsset, importMediaMutationHeaders, uploadAdminImportAsset, reconcileAdminImportAsset, selectAdminImportCover, previewAdminImportAsset, defaultImportObjectStorage, type ImportObjectStorage } from '../administration/import/adminImportStorage';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';
import { limitMediaConcurrencyFor } from '../middleware/mediaDeliveryMiddleware';
import { publishAdminImport, resumeAdminImportPublication, cancelAdminImportPublication } from '../administration/import/adminImportPublisher';

/** Mount behind app-level pre-body auth/origin/size guards; defense-in-depth guards remain here. */
export function createAdminImportRouter(storage: ImportObjectStorage = defaultImportObjectStorage) {
    const router = express.Router();
    router.use('/imports', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use('/imports', requireAuth, requireAdmin, (req, res, next) => {
        if (['GET', 'HEAD'].includes(req.method) && /\/assets\/[^/]+\/preview$/.test(req.path) && req.query.viewer !== undefined) {
            const viewer = req.query.viewer, header = req.get('X-Finitude-Account-Viewer');
            if (typeof viewer !== 'string' || !objectId(viewer) || Object.keys(req.query).some(key => key !== 'viewer')) return res.status(400).end();
            if (viewer !== (req as AuthenticatedRequest).auth!.userId || (header && header !== viewer)) return res.status(409).end();
            req.headers['x-finitude-account-viewer'] = viewer;
        }
        return requireCurrentAccountViewer(req, res, next);
    });
    router.use('/imports', express.json({ limit: '96kb', strict: true }));
    const run = (handler: (actor: string, req: express.Request) => Promise<unknown>, status = 200): express.RequestHandler => async (req, res) => {
        try { const result = await runRequestWork(req, () => handler((req as AuthenticatedRequest).auth!.userId, req)); if (!res.destroyed) res.status(status).json(result); }
        catch (error) { const known = error instanceof AdminImportError; res.status(known ? error.status : 503).json({ code: known ? error.code : 'ADMIN_IMPORT_UNAVAILABLE' }); }
    };
    router.get('/imports', asyncHandler(run((actor, req) => listAdminImports(actor, req.query))));
    router.post('/imports', asyncHandler(run((actor, req) => createAdminImport(actor, req.body), 201)));
    router.get('/imports/:id', asyncHandler(run((actor, req) => getAdminImport(actor, req.params.id))));
    router.patch('/imports/:id', asyncHandler(run((actor, req) => editAdminImport(actor, req.params.id, req.body))));
    router.post('/imports/:id/analyze', asyncHandler(run((actor, req) => analyzeAdminImport(actor, req.params.id, req.body), 202)));
    router.post('/imports/:id/adopt', asyncHandler(run((actor, req) => adoptAdminImportSuggestions(actor, req.params.id, req.body))));
    router.post('/imports/:id/decisions', asyncHandler(run((actor, req) => decideAdminImportDuplicates(actor, req.params.id, req.body))));
    router.post('/imports/:id/cancel-analysis', asyncHandler(run((actor, req) => cancelAdminImportAnalysis(actor, req.params.id, req.body))));
    router.get('/imports/:id/duplicate-candidates', asyncHandler(run((actor, req) => adminImportDuplicateCandidates(actor, req.params.id))));
    router.post('/imports/:id/publish', asyncHandler(run((actor, req) => publishAdminImport(actor, req.params.id, req.body), 202)));
    router.post('/imports/:id/cancel-publication', asyncHandler(run((actor, req) => cancelAdminImportPublication(actor, req.params.id, req.body, storage))));
    router.post('/imports/:id/resume-publication', asyncHandler(run((actor, req) => {
        if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.operationId !== 'string') throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_INPUT');
        return resumeAdminImportPublication(actor, req.params.id, req.body.operationId, storage);
    })));
    const temporary = new WeakMap<express.Request, string[]>();
    const upload = multer({ storage: multer.diskStorage({ destination: os.tmpdir(), filename(req, file, callback) { const extension = path.extname(file.originalname).slice(0, 16).replace(/[^.a-zA-Z0-9]/g, ''); const name = `archtree-import-${randomUUID()}${extension}`; const paths = temporary.get(req) ?? []; paths.push(path.join(os.tmpdir(), name)); temporary.set(req, paths); callback(null, name); } }), limits: { files: 1, fileSize: maxAudioUploadMb * 1024 ** 2, fields: 0, parts: 1 } }).single('file');
    router.post('/imports/:id/assets/:slotId', (req, res, next) => {
        if (!importEnabled() || !importPrivateStorageReady()) return res.status(503).json({ code: 'ADMIN_IMPORT_STORAGE_UNAVAILABLE' });
        try { importMediaMutationHeaders(req.get('Idempotency-Key'), req.get('If-Match')); if (!objectId(req.params.id) || (req.params.slotId !== 'cover' && !uuid(req.params.slotId))) throw new AdminImportError(400, 'ADMIN_IMPORT_INVALID_INPUT'); next(); }
        catch { res.status(400).json({ code: 'ADMIN_IMPORT_INVALID_INPUT' }); }
    }, requireUploadSize(maxAudioUploadMb + 1), (req, res, next) => {
        onRequestWorkComplete(req, res, () => { const paths = temporary.get(req) ?? []; temporary.delete(req); void Promise.all(paths.map(file => fs.unlink(file).catch(() => undefined))); });
        void runRequestWork(req, () => new Promise<void>((resolve, reject) => { const aborted = () => reject(new Error('Aborted')); req.once('aborted', aborted); upload(req, res, error => { req.off('aborted', aborted); error ? reject(error) : resolve(); }); })).then(() => next()).catch(() => { if (!res.destroyed) res.status(400).json({ code: 'ADMIN_IMPORT_INVALID_FILE' }); });
    }, asyncHandler(run((actor, req) => uploadAdminImportAsset(actor, req.params.id, req.params.slotId, importMediaMutationHeaders(req.get('Idempotency-Key'), req.get('If-Match')), req.file!, storage))));
    // HEAD-only recovery of an upload of unknown outcome; JSON body {operationId}, no bytes.
    router.post('/imports/:id/assets/:slotId/reconcile', asyncHandler(run((actor, req) => reconcileAdminImportAsset(actor, req.params.id, req.params.slotId, req.body, storage))));
    router.delete('/imports/:id/assets/:slotId', asyncHandler(run((actor, req) => cleanupAdminImportAsset(actor, req.params.id, req.params.slotId, importMediaMutationHeaders(req.get('Idempotency-Key'), req.get('If-Match')), storage))));
    router.post('/imports/:id/select-cover', asyncHandler(run((actor, req) => selectAdminImportCover(actor, req.params.id, req.body))));
    router.get('/imports/:id/assets/:slotId/preview', limitMediaConcurrencyFor('artwork'), asyncHandler(async (req, res) => {
        try { const result = await previewAdminImportAsset((req as AuthenticatedRequest).auth!.userId, req.params.id, req.params.slotId, storage); res.setHeader('X-Content-Type-Options', 'nosniff'); res.type(result.contentType).send(result.bytes); }
        catch (error) { const known = error instanceof AdminImportError; res.status(known ? error.status : 503).end(); }
    }));
    return router;
}
