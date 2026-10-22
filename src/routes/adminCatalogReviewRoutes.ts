import express from 'express';
import { requireAdmin, requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { asyncHandler } from '../middleware/requestProtectionMiddleware';
import { observeMediaDeliveryFor } from '../middleware/mediaDeliveryMiddleware';
import { runRequestWork } from '../services/platform/serverLifecycleService';
import { createMediaAbortContext } from '../services/media/mediaDeliveryService';
import { AdminImportError, objectId } from '../administration/import/adminImportContract';
import { listCatalogReviews, getCatalogReview, getCatalogReviewEligibility, analyzeCatalogReview, cancelCatalogReviewAnalysis } from '../administration/catalog/adminCatalogReviewService';
import { applyCatalogReview, decideCatalogReviewIdentities, getCatalogReviewCandidates } from '../administration/catalog/adminCatalogReviewApply';
import { catalogReviewDiscarded, discardCatalogReview } from '../administration/catalog/adminCatalogReviewDiscard';
import {
    adoptCatalogReviewSuggestions, chooseCatalogReviewLookup, createCatalogReviewWithLookup, getCatalogReviewLookup, resolveCatalogReviewLookup, retryCatalogReviewLookup, saveCatalogReview,
    submitCatalogReviewLookup
} from '../administration/lookup/catalogReviewLookupRequests';
import { defaultItunesArtworkClient, defaultLookupArtworkClient, previewLookupCandidateArtwork } from '../administration/import/adminImportLookupCover';
import type { CoverArtClient } from '../administration/lookup/coverArtClient';
import type { ItunesArtworkClient } from '../administration/lookup/itunesArtworkClient';

/**
 * Existing-Album reviews have an independent private protocol; old import routes never accept their project IDs. Creating a review
 * queues its automatic metadata lookup where available (catalogReviewLookupRequests.ts), and the eligibility read tells the Web
 * Album page whether one can be created and which open review it opens. Applying a review and its identity rows and decisions live
 * in adminCatalogReviewApply.ts. Discarding an unapplied review leaves a tombstone (adminCatalogReviewDiscard.ts): a 404 on any
 * /:id JSON route (the artwork preview keeps its bodiless 404), a retried change or read included, then says the review was
 * discarded. `artwork` and `itunesArtwork` are the candidate previews' Cover Art Archive and iTunes clients (tests inject them).
 */
export function createAdminCatalogReviewRouter(artwork: () => CoverArtClient = defaultLookupArtworkClient, itunesArtwork: () => ItunesArtworkClient = defaultItunesArtworkClient) {
    const router = express.Router();
    router.use('/catalog-reviews', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.use('/catalog-reviews', requireAuth, requireAdmin, (req, res, next) => {
        // Image elements cannot send headers, so the candidate artwork route names the viewer in the query instead, as for imports.
        if (['GET', 'HEAD'].includes(req.method) && /^\/[^/]+\/lookup\/candidates\/[^/]+\/artwork$/.test(req.path) && req.query.viewer !== undefined) {
            const viewer = req.query.viewer, header = req.get('X-Finitude-Account-Viewer');
            if (typeof viewer !== 'string' || !objectId(viewer) || Object.keys(req.query).some(key => key !== 'viewer')) return res.status(400).end();
            if (viewer !== (req as AuthenticatedRequest).auth!.userId || (header && header !== viewer)) return res.status(409).end();
            req.headers['x-finitude-account-viewer'] = viewer;
        }
        return requireCurrentAccountViewer(req, res, next);
    });
    // A save carries each changed value and its base, so up to two copies of a 48 KB draft (as an import field save); a lookup
    // submission, retry or choice is a few fields (8 KB; Express routes ignore case, so the selectors do too); conflict answers
    // carry up to 406 bases, member Artist entries and an expected tracklist among them (512 KB); an apply or identity decisions
    // carry up to 513 preselections or decisions and 513 ID writes besides the selected fields and members (768 KB); every other
    // body stays at 96 KB.
    const json = express.json({ limit: '96kb', strict: true }), fieldSaveJson = express.json({ limit: '160kb', strict: true }), lookupJson = express.json({ limit: '8kb', strict: true });
    const answersJson = express.json({ limit: '512kb', strict: true }), identityJson = express.json({ limit: '768kb', strict: true });
    router.use('/catalog-reviews', (req, res, next) => (req.method === 'PATCH' && /^\/[^/]+\/?$/.test(req.path) ? fieldSaveJson
        : req.method === 'POST' && /^\/[^/]+\/lookup(?:\/(?:retry|choose))?\/?$/i.test(req.path) ? lookupJson
            : req.method === 'POST' && /^\/[^/]+\/lookup\/resolve\/?$/i.test(req.path) ? answersJson
                : req.method === 'POST' && /^\/[^/]+\/(?:apply|decisions)\/?$/i.test(req.path) ? identityJson : json)(req, res, next));
    const run = (handler: (actor: string, req: express.Request) => Promise<unknown>, status = 200): express.RequestHandler => async (req, res) => {
        try {
            const value = await runRequestWork(req, () => handler((req as AuthenticatedRequest).auth!.userId, req));
            if (!res.destroyed) res.status(status).json(value);
        } catch (error) {
            const known = error instanceof AdminImportError, discarded = known && error.status === 404 && typeof req.params.id === 'string' && await catalogReviewDiscarded(req.params.id);
            res.status(known ? error.status : 503).json({ code: discarded ? 'ADMIN_CATALOG_REVIEW_DISCARDED' : known ? error.code : 'ADMIN_CATALOG_REVIEW_UNAVAILABLE' });
        }
    };
    router.get('/catalog-reviews', asyncHandler(run((actor, req) => listCatalogReviews(actor, req.query))));
    router.post('/catalog-reviews', asyncHandler(run((actor, req) => createCatalogReviewWithLookup(actor, req.body), 201)));
    // Registered before the detail route, which would otherwise read `eligibility` as a review ID.
    router.get('/catalog-reviews/eligibility', asyncHandler(run((actor, req) => getCatalogReviewEligibility(actor, req.query))));
    router.get('/catalog-reviews/:id', asyncHandler(run((actor, req) => getCatalogReview(actor, req.params.id))));
    // A save, and accepting Luna suggestions, re-rank the review's completed lookup run when they change a member's own Disc or Track
    // Number.
    router.patch('/catalog-reviews/:id', asyncHandler(run((actor, req) => saveCatalogReview(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/analyze', asyncHandler(run((actor, req) => analyzeCatalogReview(actor, req.params.id, req.body), 202)));
    router.post('/catalog-reviews/:id/adopt', asyncHandler(run((actor, req) => adoptCatalogReviewSuggestions(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/cancel-analysis', asyncHandler(run((actor, req) => cancelCatalogReviewAnalysis(actor, req.params.id, req.body))));
    // Applying the selected saved values, and the identity rows and decisions an apply of Artist entries and the label waits for
    // (adminCatalogReviewApply.ts); the Web review summary reads the candidates and saves decisions, and its apply confirmation sends
    // the selected fields and members with the identity items it showed.
    router.post('/catalog-reviews/:id/apply', asyncHandler(run((actor, req) => applyCatalogReview(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/discard', asyncHandler(run((actor, req) => discardCatalogReview(actor, req.params.id, req.body))));
    router.get('/catalog-reviews/:id/candidates', asyncHandler(run((actor, req) => getCatalogReviewCandidates(actor, req.params.id))));
    router.post('/catalog-reviews/:id/decisions', asyncHandler(run((actor, req) => decideCatalogReviewIdentities(actor, req.params.id, req.body))));
    router.get('/catalog-reviews/:id/lookup', asyncHandler(run((actor, req) => getCatalogReviewLookup(actor, req.params.id))));
    router.post('/catalog-reviews/:id/lookup', asyncHandler(run((actor, req) => submitCatalogReviewLookup(actor, req.params.id, req.body), 202)));
    router.post('/catalog-reviews/:id/lookup/retry', asyncHandler(run((actor, req) => retryCatalogReviewLookup(actor, req.params.id, req.body), 202)));
    router.post('/catalog-reviews/:id/lookup/choose', asyncHandler(run((actor, req) => chooseCatalogReviewLookup(actor, req.params.id, req.body))));
    router.post('/catalog-reviews/:id/lookup/resolve', asyncHandler(run((actor, req) => resolveCatalogReviewLookup(actor, req.params.id, req.body))));
    // A transient WebP preview of a review lookup candidate's front artwork, bounded and observed as the import preview is; no bytes
    // are stored, and an error has no body.
    router.get('/catalog-reviews/:id/lookup/candidates/:key/artwork', observeMediaDeliveryFor('artwork'), asyncHandler(async (req, res) => {
        const context = createMediaAbortContext(req, res);
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            const { userId, sessionId } = (req as AuthenticatedRequest).auth!;
            const body = await runRequestWork(req, () => previewLookupCandidateArtwork(userId, sessionId, req.params.id, req.params.key, context.signal, 'catalogReview', artwork(), itunesArtwork()));
            if (res.destroyed) return;
            res.setHeader('X-Content-Type-Options', 'nosniff'); res.type('image/webp').send(body);
        } catch (error) {
            if (context.aborted || res.headersSent) return;
            res.status(error instanceof AdminImportError ? error.status : 503).end();
        } finally { context.cleanup(); }
    }));
    return router;
}
