import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { attachRequestAbortSignal, getRequestAbortSignal, uploadConcurrencyLimit, asyncHandler } from '../middleware/requestProtectionMiddleware';
import { requireUploadSize } from '../middleware/audioUpload';
import { onRequestWorkComplete, runRequestWork } from '../services/serverLifecycleService';
import { CONVERSION_MAX_BYTES, AdminConversionError, conversionExact, conversionRecord } from '../administration/conversionContract';
import { getConversionAlbumSource, getConversionTrackSource } from '../administration/conversionSources';
import { getConversionImportReady } from '../administration/conversionImportProof';
import { cancelConversionOperation, getConversionOperation, prepareConversionOperation, reconcileConversionOperation, requireConversionUploadAccess, uploadConversionOutput, type AdminConversionDependencies } from '../administration/conversionService';

/** Auth, viewer, schema and file bounds precede all administrator conversion operations. */
export function createAdminConversionRouter(dependencies: AdminConversionDependencies = {}) {
    const router = express.Router();
    router.use('/conversions', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.use('/conversions', requireAuth, requireAdmin, requireCurrentAccountViewer, express.json({ limit: '16kb', strict: true }));
    const run = (work: (actor: string, req: express.Request) => Promise<unknown>, status = 200): express.RequestHandler => async (req, res) => {
        try { const result = await runRequestWork(req, () => work((req as AuthenticatedRequest).auth!.userId, req)); if (!res.destroyed) res.status(status).json(result); }
        catch (error: any) {
            if (res.destroyed) return;
            const code = typeof error?.code === 'string' && /^(ADMIN_CONVERSION_|ADMIN_PERMISSION_REQUIRED|ADMIN_CATALOG_)/.test(error.code) ? error.code : 'ADMIN_CONVERSION_UNAVAILABLE';
            const status = [400, 401, 403, 404, 409, 412, 413, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
            res.status(status).json({ code });
        }
    };
    router.get('/conversions/albums/:id/source', asyncHandler(run((actor, req) => getConversionAlbumSource(actor, req.params.id))));
    router.get('/conversions/tracks/:id/source', asyncHandler(run((actor, req) => getConversionTrackSource(actor, req.params.id))));
    router.get('/conversions/imports/:id/ready', asyncHandler(run((actor, req) => getConversionImportReady(actor, req.params.id, dependencies.storage))));
    router.post('/conversions/imports/:id/ready', asyncHandler(run((actor, req) => {
        const body = conversionRecord(req.body); conversionExact(body, ['slots']);
        if (!Array.isArray(body.slots) || body.slots.some(slot => typeof slot !== 'string')) throw new AdminConversionError(400, 'ADMIN_CONVERSION_INVALID_INPUT');
        return getConversionImportReady(actor, req.params.id, dependencies.storage, body.slots as string[]);
    })));
    router.post('/conversions/tracks/:id/operations', asyncHandler(run((actor, req) => prepareConversionOperation(actor, req.params.id, req.body, dependencies), 201)));
    router.get('/conversions/tracks/:id/operations/:operationId', asyncHandler(run((actor, req) => getConversionOperation(actor, req.params.id, req.params.operationId, dependencies))));
    router.post('/conversions/tracks/:id/operations/:operationId/reconcile', asyncHandler(run((actor, req) => {
        const body = conversionRecord(req.body); conversionExact(body, []);
        return reconcileConversionOperation(actor, req.params.id, req.params.operationId, dependencies);
    })));
    router.post('/conversions/tracks/:id/operations/:operationId/cancel', asyncHandler(run((actor, req) => {
        const body = conversionRecord(req.body); conversionExact(body, []);
        return cancelConversionOperation(actor, req.params.id, req.params.operationId, dependencies);
    })));
    const temporary = new WeakMap<express.Request, string[]>();
    const upload = multer({ storage: multer.diskStorage({ destination: os.tmpdir(), filename(req, _file, done) {
        const name = `archtree-conversion-${randomUUID()}.mp3`, files = temporary.get(req) ?? [];
        files.push(path.join(os.tmpdir(), name)); temporary.set(req, files); done(null, name);
    } }), limits: { files: 1, fileSize: CONVERSION_MAX_BYTES, fields: 0, parts: 1, headerPairs: 100, fieldNameSize: 100 } }).single('audioFile');
    router.post('/conversions/tracks/:id/operations/:operationId/upload', asyncHandler(async (req, res, next) => {
        try { await runRequestWork(req, () => requireConversionUploadAccess((req as AuthenticatedRequest).auth!.userId, req.params.id, req.params.operationId)); next(); }
        catch (error: any) { if (!res.destroyed) res.status([400, 403, 404, 409, 503].includes(error?.statusCode) ? error.statusCode : 503).json({ code: error instanceof AdminConversionError ? error.code : 'ADMIN_CONVERSION_UNAVAILABLE' }); }
    }), uploadConcurrencyLimit, attachRequestAbortSignal,
        requireUploadSize(CONVERSION_MAX_BYTES / 1024 ** 2 + 1), (req, res, next) => {
            onRequestWorkComplete(req, res, () => {
                const files = temporary.get(req) ?? []; temporary.delete(req);
                void Promise.all(files.map(file => fs.unlink(file).catch(() => undefined)));
            });
            void runRequestWork(req, () => new Promise<void>((resolve, reject) => {
                const aborted = () => reject(new Error('Aborted')); req.once('aborted', aborted);
                upload(req, res, error => { req.off('aborted', aborted); error ? reject(error) : resolve(); });
            })).then(() => next()).catch(() => { if (!res.destroyed) res.status(400).json({ code: 'ADMIN_CONVERSION_INVALID_MP3' }); });
        }, asyncHandler(run((actor, req) => uploadConversionOutput(actor, req.params.id, req.params.operationId, req.file!, dependencies, getRequestAbortSignal(req)))));
    return router;
}
