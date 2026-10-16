import express, { Request, Router } from 'express';

import { AuthenticatedRequest, requireAdminForWeb, requireAuthForWeb } from '../middleware/authMiddleware';
import { asyncHandler, limitConcurrency } from '../middleware/requestProtectionMiddleware';
import {
    changePortfolio,
    createMongoPortfolioStore,
    resolvePortfolio,
    type PortfolioChange,
    type PortfolioStore
} from '../portfolio/portfolioStore';
import { isPortfolioVisibility } from '../portfolio/projectCatalog';
import {
    isPortfolioAdminNotice,
    portfolioAdminPath,
    renderPortfolioAdminPage,
    type PortfolioAdminNotice
} from '../views/portfolio/adminProjectsView';

interface PortfolioAdminRouterOptions {
    store?: PortfolioStore;
}

const allowedKeys = (value: unknown, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));

/** Parses the hidden revision field; anything but a small non-negative integer is invalid. */
const parseRevision = (value: unknown) => typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : null;

/** Turns a validated form body into one change, or null when the body is malformed. */
const parseChange = (req: Request): { revision: number; change: PortfolioChange } | null => {
    const slug = req.params.slug;
    const revision = parseRevision(req.body?.revision);
    if (revision === null || !allowedKeys(req.query, [])) return null;
    if (req.params.action === 'move') {
        const direction = req.body?.direction;
        if (!allowedKeys(req.body, ['revision', 'direction']) || (direction !== 'up' && direction !== 'down')) return null;
        return { revision, change: { kind: 'move', slug, direction } };
    }
    if (req.params.action === 'visibility') {
        const visibility = req.body?.visibility;
        if (!allowedKeys(req.body, ['revision', 'visibility']) || !isPortfolioVisibility(visibility)) return null;
        return { revision, change: { kind: 'visibility', slug, visibility } };
    }
    return null;
};

/**
 * Administrator console for homepage project order and visibility, mounted at
 * `/admin/projects`. Browser forms post back here and redirect with a fixed
 * notice code. The app's same-origin cookie mutation guard and form parser
 * run before this router.
 */
export const createPortfolioAdminRouter = (options: PortfolioAdminRouterOptions = {}): Router => {
    const router = express.Router();
    const store = options.store ?? createMongoPortfolioStore();
    router.use(requireAuthForWeb, requireAdminForWeb, (_req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        next();
    });
    const mutationCapacity = limitConcurrency('portfolio-admin', 2, 4);
    const redirect = (res: express.Response, notice: PortfolioAdminNotice) =>
        res.redirect(303, `${portfolioAdminPath}?notice=${notice}`);

    router.get('/', asyncHandler(async (req, res) => {
        const notice = req.query.notice;
        if (!allowedKeys(req.query, ['notice']) || (notice !== undefined && !isPortfolioAdminNotice(notice))) {
            return redirect(res, 'invalid');
        }
        return res.status(200).type('html').send(renderPortfolioAdminPage({
            adminEmail: (req as AuthenticatedRequest).auth?.email ?? 'Administrator',
            portfolio: resolvePortfolio(await store.read()),
            notice: isPortfolioAdminNotice(notice) ? notice : null
        }));
    }));

    router.post('/:slug/:action', mutationCapacity, asyncHandler(async (req, res) => {
        const parsed = parseChange(req);
        if (!parsed) return redirect(res, 'invalid');
        try {
            const outcome = await changePortfolio(store, parsed.revision, parsed.change, (req as AuthenticatedRequest).auth!.userId);
            return redirect(res, outcome);
        } catch {
            return redirect(res, 'unavailable');
        }
    }));

    return router;
};
