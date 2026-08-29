import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import {
  asyncHandler,
  attachRequestAbortSignal,
  getRequestAbortSignal,
  limitConcurrency,
  rateLimit,
  requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';
import { NarutoMobileOpenAiClassifier, NarutoMobileUpstreamError } from '../narutoMobile/openAiClassifierService';
import {
  NARUTO_MOBILE_PROTOCOL_VERSION,
  NarutoMobileProtocolError,
  parseNarutoMobileClassifyRequest
} from '../narutoMobile/protocol';

const router: Router = express.Router();
const model = 'gpt-5.6-luna';

const runtimeSettings = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  return apiKey ? {apiKey} : undefined;
};

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

const requireReady: RequestHandler = (_req, res, next) => {
  if (!runtimeSettings()) {
    res.status(503).json({ code: 'service_disabled', message: 'Analysis service is not enabled.' });
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

const apiRateLimit = rateLimit('naruto-mobile', 60, 60_000);
const classifyConcurrencyLimit = limitConcurrency('naruto-mobile-classify', 3, 3);
const requireDesktopAccount = [
  requireSecureAuthTransport,
  apiRateLimit,
  requireReady,
  requireBearerHeader,
  requireAuth
] as const;

router.use(privateApiHeaders);

router.get('/status', (_req, res) => {
  res.status(200).json({
    enabled: Boolean(runtimeSettings()),
    protocolVersion: NARUTO_MOBILE_PROTOCOL_VERSION,
    serviceVersion: 'naruto-mobile-proxy-v1'
  });
});

router.get('/access', ...requireDesktopAccount, (_req, res) => {
  res.status(200).json({ authorized: true, protocolVersion: NARUTO_MOBILE_PROTOCOL_VERSION });
});

router.post(
  '/classify',
  ...requireDesktopAccount,
  express.json({ limit: '1mb', strict: true }),
  classifyConcurrencyLimit,
  attachRequestAbortSignal,
  asyncHandler(async (req, res) => {
    const settings = runtimeSettings();
    if (!settings) {
      res.status(503).json({ code: 'service_disabled', message: 'Analysis service is not enabled.' });
      return;
    }
    const request = parseNarutoMobileClassifyRequest(req.body);
    const classifier = new NarutoMobileOpenAiClassifier({
      apiKey: settings.apiKey,
      model,
      reasoningEffort: 'medium',
      timeoutMs: 105_000
    });
    res.status(200).json(await classifier.classify(request, getRequestAbortSignal(req)));
  })
);

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  if (error instanceof NarutoMobileProtocolError) {
    res.status(400).json({ code: 'invalid_request', message: error.message });
    return;
  }
  if (error instanceof NarutoMobileUpstreamError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(error.statusCode).json({
      code: error.statusCode === 429 ? 'upstream_rate_limited' : 'upstream_unavailable',
      message: error.message
    });
    return;
  }
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'invalid_json', message: 'Request JSON is invalid.' });
    return;
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ code: 'request_too_large', message: 'Request body is too large.' });
    return;
  }
  next(error);
});

export default router;
