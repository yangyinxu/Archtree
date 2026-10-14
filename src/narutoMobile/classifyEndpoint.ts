import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import {
  getRequestAbortSignal,
  limitConcurrency,
  rateLimit
} from '../middleware/requestProtectionMiddleware';
import { NarutoMobileOpenAiClassifier, NarutoMobileUpstreamError } from './openAiClassifierService';
import { NarutoMobileProtocolError, parseNarutoMobileClassifyRequest } from './protocol';

export const narutoAnalysisModel = 'gpt-6-luna';
export const narutoMaxConcurrentRequests = 12;

/** Reads only server-owned provider configuration; clients cannot override it. */
const runtimeSettings = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  return apiKey ? {
    apiKey,
    organizationId: process.env.OPENAI_ORG_ID?.trim() || undefined,
    projectId: process.env.OPENAI_PROJECT_ID?.trim() || undefined
  } : undefined;
};

/** Publishes availability without returning any provider credential or project identity. */
export const narutoAnalysisEnabled = () => Boolean(runtimeSettings());

/** Keeps desktop and browser callers inside one process-wide provider budget. */
export const narutoApiRateLimit = rateLimit('naruto-mobile', 60, 60_000);
export const narutoClassifyConcurrencyLimit = limitConcurrency(
  'naruto-mobile-classify', narutoMaxConcurrentRequests, narutoMaxConcurrentRequests
);

/** Rejects unavailable analysis before accepting a classifier body. */
export const requireNarutoAnalysisReady: RequestHandler = (_req, res, next) => {
  if (!narutoAnalysisEnabled()) {
    res.status(503).json({ code: 'service_disabled', message: 'Analysis service is not enabled.' });
    return;
  }
  next();
};

/** Executes the fixed, bounded classification protocol without storing private inputs. */
export const classifyNarutoRequest = async (req: Request, res: Response): Promise<void> => {
  const settings = runtimeSettings();
  if (!settings) {
    res.status(503).json({ code: 'service_disabled', message: 'Analysis service is not enabled.' });
    return;
  }
  const request = parseNarutoMobileClassifyRequest(req.body);
  const classifier = new NarutoMobileOpenAiClassifier({
    apiKey: settings.apiKey,
    organizationId: settings.organizationId,
    projectId: settings.projectId,
    model: narutoAnalysisModel,
    reasoningEffort: 'medium',
    timeoutMs: 105_000
  });
  res.status(200).json(await classifier.classify(request, getRequestAbortSignal(req)));
};

/** Returns protocol-safe errors without exposing upstream request or response payloads. */
export const handleNarutoAnalysisError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
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
};
