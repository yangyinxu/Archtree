import express, { type RequestHandler, type Router } from 'express';
import { requireBrowserAuth, requireCurrentAccountViewer } from '../middleware/authMiddleware';
import { asyncHandler, attachRequestAbortSignal, requireSecureAuthTransport } from '../middleware/requestProtectionMiddleware';
import {
  cookieMutationRejection,
  requireStrictSameOriginBrowserMutation,
  setBrowserSessionPrivacyHeaders
} from '../services/auth/authCookieService';
import {
  classifyNarutoRequest,
  handleNarutoAnalysisError,
  narutoAnalysisEnabled,
  narutoAnalysisModel,
  narutoApiRateLimit,
  narutoClassifyConcurrencyLimit,
  narutoMaxConcurrentRequests,
  requireNarutoAnalysisReady
} from './classifyEndpoint';
import { NARUTO_MOBILE_PROTOCOL_VERSION } from './protocol';

/** Allows only this origin's browser requests; sibling-origin allowlists do not apply. */
const requireNarutoBrowserOrigin: RequestHandler = (req, res, next) => {
  for (const header of [
    'Access-Control-Allow-Origin', 'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers', 'Access-Control-Expose-Headers'
  ]) res.removeHeader(header);
  setBrowserSessionPrivacyHeaders(res);
  const host = req.get('Host');
  if (!host) {
    res.status(400).json({ message: 'A valid request host is required.' });
    return;
  }
  const rejection = cookieMutationRejection({
    origin: req.get('Origin'),
    requestOrigin: `${req.protocol}://${host}`,
    secFetchSite: req.get('Sec-Fetch-Site')
  });
  if (rejection) {
    res.status(rejection.status).json({ message: rejection.message });
    return;
  }
  // The shared viewer guard exempts native Bearer clients. This surface is
  // cookie-only, so never let an Authorization header skip the browser fence.
  if (req.get('Authorization')) {
    res.status(401).json({ code: 'browser_session_required', message: 'A browser session is required.' });
    return;
  }
  next();
};

/** Reuses browser account fencing and the desktop classifier without accepting desktop credentials. */
export const createNarutoBrowserRouter = (): Router => {
  const router = express.Router();
  router.use(requireNarutoBrowserOrigin);
  router.get('/status', (_req, res) => {
    res.status(200).json({
      enabled: narutoAnalysisEnabled(),
      protocolVersion: NARUTO_MOBILE_PROTOCOL_VERSION,
      serviceVersion: 'naruto-browser-proxy-v1',
      maxConcurrentRequests: narutoMaxConcurrentRequests,
      model: narutoAnalysisModel
    });
  });
  router.post(
    '/classify',
    requireStrictSameOriginBrowserMutation,
    requireSecureAuthTransport,
    narutoApiRateLimit,
    requireBrowserAuth,
    requireCurrentAccountViewer,
    requireNarutoAnalysisReady,
    narutoClassifyConcurrencyLimit,
    express.json({ limit: '1mb', strict: true }),
    attachRequestAbortSignal,
    asyncHandler(classifyNarutoRequest)
  );
  router.use(handleNarutoAnalysisError);
  // An unknown browser API must never reach the site's SPA index fallback.
  router.use((_req, res) => res.status(404).json({ message: 'The requested Naruto API was not found.' }));
  return router;
};
