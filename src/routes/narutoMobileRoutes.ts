import express, { RequestHandler, Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import {
  asyncHandler,
  attachRequestAbortSignal,
  requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';
import {
  classifyNarutoRequest,
  handleNarutoAnalysisError,
  narutoAnalysisEnabled,
  narutoApiRateLimit,
  narutoClassifyConcurrencyLimit,
  narutoMaxConcurrentRequests,
  requireNarutoAnalysisReady
} from '../narutoMobile/classifyEndpoint';
import {
  NARUTO_MOBILE_PROTOCOL_VERSION
} from '../narutoMobile/protocol';

const router: Router = express.Router();
const privateApiHeaders: RequestHandler = (req, res, next) => {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Methods');
  res.removeHeader('Access-Control-Allow-Headers');
  res.removeHeader('Access-Control-Expose-Headers');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (req.get('origin')) {
    res.status(403).json({ code: 'browser_origin_rejected', message: 'Browser requests are not accepted.' });
    return;
  }
  next();
};

/** Keeps cookie-authenticated browsers out of this desktop-only paid endpoint. */
const requireBearerHeader: RequestHandler = (req, res, next) => {
  if (!/^Bearer [^\s]+$/.test(req.get('authorization') ?? '')) {
    res.status(401).json({ code: 'login_required', message: 'Archtree login is required.' });
    return;
  }
  next();
};

const requireDesktopAccount = [
  requireSecureAuthTransport,
  narutoApiRateLimit,
  requireNarutoAnalysisReady,
  requireBearerHeader,
  requireAuth
] as const;

router.use(privateApiHeaders);

router.get('/status', (_req, res) => {
  res.status(200).json({
    enabled: narutoAnalysisEnabled(),
    protocolVersion: NARUTO_MOBILE_PROTOCOL_VERSION,
    serviceVersion: 'naruto-mobile-proxy-v1',
    maxConcurrentRequests: narutoMaxConcurrentRequests
  });
});

router.get('/access', ...requireDesktopAccount, (_req, res) => {
  res.status(200).json({ authorized: true, protocolVersion: NARUTO_MOBILE_PROTOCOL_VERSION });
});

router.post(
  '/classify',
  ...requireDesktopAccount,
  express.json({ limit: '1mb', strict: true }),
  narutoClassifyConcurrencyLimit,
  attachRequestAbortSignal,
  asyncHandler(classifyNarutoRequest)
);

router.use(handleNarutoAnalysisError);

export default router;
