import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

type RequestArea = 'auth' | 'content' | 'listener' | 'media' | 'other';
const areas: RequestArea[] = ['auth', 'content', 'listener', 'media', 'other'];
const durationBoundsMs = [50, 100, 250, 500, 1_000, 5_000];

/** Classifies only fixed route families, never retaining URL text or identifiers. */
const areaFor = (req: Request): RequestArea => {
  if (req.path.startsWith('/auth')) return 'auth';
  if (req.path.startsWith('/content')) return 'content';
  if (req.path.startsWith('/api/listener')) return 'listener';
  if (req.path.startsWith('/video')) return 'media';
  return 'other';
};

/** Uses fixed-cardinality counters so anonymous diagnostics have bounded memory. */
export const createRequestDiagnostics = () => {
  const counters = Object.fromEntries(areas.map(area => [area, {
    active: 0, completed: 0, failed: 0, aborted: 0,
    durationBuckets: Array<number>(durationBoundsMs.length + 1).fill(0)
  }])) as Record<RequestArea, {
    active: number; completed: number; failed: number; aborted: number; durationBuckets: number[];
  }>;
  const observe: RequestHandler = (req, res, next) => {
    // Always create our own identifier; accepting a caller's value would permit log injection.
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    const counter = counters[areaFor(req)];
    const startedAt = performance.now();
    counter.active += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      res.off('finish', finish);
      res.off('close', finish);
      counter.active -= 1;
      counter.completed += 1;
      if (!res.writableFinished) counter.aborted += 1;
      if (res.statusCode >= 500) counter.failed += 1;
      const duration = performance.now() - startedAt;
      const bucket = durationBoundsMs.findIndex(bound => duration <= bound);
      counter.durationBuckets[bucket < 0 ? durationBoundsMs.length : bucket] += 1;
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
  return {
    observe,
    snapshot: () => ({ scope: 'process' as const, durationBoundsMs: [...durationBoundsMs],
      byArea: structuredClone(counters) })
  };
};

/** Maps only known error classes/codes; no exception message, stack, or payload is logged. */
export const safeServerErrorCategory = (error: unknown) => {
  const value = error as { code?: unknown; name?: unknown } | null;
  if (value?.code === 'database_index_unavailable') return 'database_constraint';
  if (typeof value?.name === 'string' && [
    'MongoNetworkError', 'MongoServerError', 'MongoServerSelectionError', 'MongoNetworkTimeoutError'
  ].includes(value.name)) return 'database';
  if (value?.name === 'AbortError') return 'aborted';
  if (value?.code === 'ETIMEDOUT') return 'timeout';
  return 'internal';
};
