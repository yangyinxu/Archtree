import { Router } from 'express';
import { requireAdmin, requireAuth, requireCurrentAccountViewer } from '../middleware/authMiddleware';
import { getAdminCapabilities } from '../services/adminCapabilityService';

/** Private capability bootstrap verifies the current database-backed role and viewer. */
export const createAdminCapabilitiesRouter = () => {
    const router = Router();
    router.get('/capabilities', requireAuth, requireAdmin, requireCurrentAccountViewer, (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(getAdminCapabilities());
    });
    return router;
};
