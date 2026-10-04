import express, { NextFunction, Request, Response, Router } from 'express';
import {
    createSocialModerationService, isSocialReportId, SOCIAL_MODERATION_LIMITS,
    type SocialModerationApi, type SocialModerationProfile, type SocialModerationReportPage, type SocialReportState
} from '../application/social/socialModerationService';
import { isSocialId, normalizeSocialHandle, SocialError } from '../contracts/socialV1';
import { AuthenticatedRequest, requireAdmin, requireAuth } from '../middleware/authMiddleware';
import { asyncHandler, limitConcurrency } from '../middleware/requestProtectionMiddleware';
import { isSocialModerationNotice, renderSocialModerationPage, type SocialModerationNotice } from '../views/admin/socialModerationView';

export const socialModerationPath = '/admin/social/reports';

interface SocialModerationRouterOptions { service?: SocialModerationApi }

const invalid = () => new SocialError(400, 'invalid_request');
const allowedKeys = (value: unknown, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
/** Repeated query values parse as arrays; every accepted query value must be one string. */
const singleValued = (query: Request['query']) => Object.values(query).every(value => typeof value === 'string');
const single = (value: unknown) => typeof value === 'string' ? value : undefined;
const isBrowserForm = (req: Request) => Boolean(req.is('application/x-www-form-urlencoded'));
const adminActor = (req: Request) => ({ userId: (req as AuthenticatedRequest).auth!.userId });

/** Maps a refusal to a fixed page notice, so a redirect never carries caller input or listener identity. */
const refusalNotice = (error: SocialError): SocialModerationNotice => error.code === 'profile_unavailable' ? 'profile_unavailable'
    : error.code === 'report_unavailable' ? 'report_unavailable' : error.code === 'mutation_outcome_unknown' ? 'outcome_unknown'
        : error.statusCode >= 500 ? 'unavailable' : 'invalid';

/**
 * Administrator-only social moderation. JSON by default for scripted use; a browser asking for
 * HTML gets the moderation page, whose forms post back here and redirect with a fixed notice code.
 * The app's same-origin cookie mutation guard and body parsers run before this router.
 */
export const createSocialModerationRouter = (options: SocialModerationRouterOptions = {}): Router => {
    const router = express.Router();
    const service = options.service ?? createSocialModerationService();
    router.use(requireAuth, requireAdmin, (_req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Pragma', 'no-cache');
        next();
    });
    const mutationCapacity = limitConcurrency('social-moderation', 2, 8);

    router.get('/reports', asyncHandler(async (req, res) => {
        if (!allowedKeys(req.query, ['state', 'limit', 'cursor', 'handle', 'format', 'notice']) || !singleValued(req.query)) throw invalid();
        const state = (single(req.query.state) ?? 'open') as SocialReportState;
        const rawLimit = single(req.query.limit);
        const limit = rawLimit === undefined ? SOCIAL_MODERATION_LIMITS.page : /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : NaN;
        const cursor = single(req.query.cursor);
        const handleQuery = single(req.query.handle);
        const html = req.query.format !== 'json' && req.accepts(['json', 'html']) === 'html';
        // The handle lookup and notice belong to the page; JSON callers use GET /profiles.
        if (!['open', 'resolved'].includes(state) || !Number.isSafeInteger(limit)
            || (req.query.cursor !== undefined && !cursor) || (req.query.handle !== undefined && (handleQuery === undefined || !html))
            || (req.query.notice !== undefined && (!html || !isSocialModerationNotice(req.query.notice)))
            || (req.query.format !== undefined && req.query.format !== 'json')) throw invalid();
        const page: SocialModerationReportPage = await service.listReports({ state, limit, cursor });
        if (!html) return res.status(200).json(page);
        const handle = handleQuery?.trim() ? normalizeSocialHandle(handleQuery.trim()) : null;
        const lookup = handleQuery?.trim() ? { handle: handleQuery.trim().slice(0, 24), profile: handle ? await service.findProfile(handle) : null } : null;
        return res.status(200).type('html').send(renderSocialModerationPage({
            adminEmail: (req as AuthenticatedRequest).auth?.email ?? 'Administrator', state, page,
            suspended: await service.listSuspended(), lookup,
            notice: isSocialModerationNotice(req.query.notice) ? req.query.notice : null
        }));
    }));
    router.get('/profiles', asyncHandler(async (req, res) => {
        if (!allowedKeys(req.query, ['handle', 'suspended']) || !singleValued(req.query)) throw invalid();
        let items: SocialModerationProfile[];
        if (req.query.suspended === 'true' && req.query.handle === undefined) items = await service.listSuspended();
        else if (req.query.suspended === undefined && typeof req.query.handle === 'string') {
            const handle = normalizeSocialHandle(req.query.handle);
            if (!handle) throw invalid();
            const profile = await service.findProfile(handle);
            items = profile ? [profile] : [];
        } else throw invalid();
        res.status(200).json({ items });
    }));

    /** Browser forms redirect back to the page; JSON callers receive the outcome and current view. */
    const respond = (req: Request, res: Response, outcome: 'applied' | 'noop', value: unknown, notice: SocialModerationNotice) => {
        if (isBrowserForm(req)) return res.redirect(303, `${socialModerationPath}?notice=${notice}`);
        return res.status(200).json({ outcome, value });
    };
    router.post('/reports/:reportId/resolve', mutationCapacity, asyncHandler(async (req, res) => {
        if (!allowedKeys(req.query, []) || !allowedKeys(req.body ?? {}, ['resolution']) || !isSocialReportId(req.params.reportId)
            || (req.body?.resolution !== 'dismissed' && req.body?.resolution !== 'actioned')) throw invalid();
        const result = await service.resolveReport(adminActor(req), req.params.reportId, req.body.resolution);
        respond(req, res, result.outcome, result.value, result.outcome === 'applied' ? 'resolved' : 'already_resolved');
    }));
    for (const action of ['suspend', 'unsuspend'] as const) {
        router.post(`/profiles/:socialId/${action}`, mutationCapacity, asyncHandler(async (req, res) => {
            if (!allowedKeys(req.query, []) || !allowedKeys(req.body ?? {}, []) || !isSocialId(req.params.socialId)) throw invalid();
            const result = await service[action](adminActor(req), req.params.socialId);
            respond(req, res, result.outcome, result.value, action === 'suspend'
                ? result.outcome === 'applied' ? 'suspended' : 'already_suspended'
                : result.outcome === 'applied' ? 'unsuspended' : 'not_suspended');
        }));
    }

    router.use((_req, _res, next) => next(new SocialError(404, 'not_found')));
    router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
        if (!(error instanceof SocialError) || res.headersSent) return next(error);
        if (req.method === 'POST' && isBrowserForm(req)) {
            return res.redirect(303, `${socialModerationPath}?notice=${refusalNotice(error)}`);
        }
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
    });
    return router;
};
