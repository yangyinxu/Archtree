import type { z } from 'zod';
import { apiRequest, ApiError, type ApiRequestOptions } from './client';
import { subscribeToAccountEpoch } from './accountEpoch';

interface ReadQueue { tail: Promise<unknown>; controller: AbortController }
interface ReadCooling { deadline: number; timer?: ReturnType<typeof setTimeout> }
const queues = new Map<string, ReadQueue>();
const cooling = new Map<string, ReadCooling>();
const activeReadDeadlineMs = 30_000;
const maximumCoolingViewers = 16;

/** Short-lived admission hints survive an idle queue, while retaining at most sixteen viewer keys. */
const coolSubsequentGets = (viewer: string, seconds: number | undefined) => {
  if (!Number.isInteger(seconds) || !seconds || seconds < 1 || seconds > 60) return;
  const previous = cooling.get(viewer);
  if (previous) clearTimeout(previous.timer);
  else if (cooling.size >= maximumCoolingViewers) {
    const oldestViewer = cooling.keys().next().value!;
    clearTimeout(cooling.get(oldestViewer)!.timer);
    cooling.delete(oldestViewer);
  }
  const entry: ReadCooling = {
    deadline: Math.max(previous?.deadline ?? 0, performance.now() + seconds * 1000)
  };
  const expire = () => {
    if (cooling.get(viewer) !== entry) return;
    const remaining = entry.deadline - performance.now();
    if (remaining > 0) entry.timer = setTimeout(expire, Math.ceil(remaining));
    else cooling.delete(viewer);
  };
  cooling.set(viewer, entry);
  entry.timer = setTimeout(expire, Math.ceil(entry.deadline - performance.now()));
};

/** Rechecks monotonic admission after each wait; cancellation never dispatches a cooled request. */
const waitForGetAdmission = async (viewer: string, signal: AbortSignal) => {
  for (;;) {
    signal.throwIfAborted();
    const remaining = (cooling.get(viewer)?.deadline ?? 0) - performance.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const complete = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(complete, Math.ceil(remaining));
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
};

subscribeToAccountEpoch(() => {
  const previous = [...queues.values()];
  // A transport that ignores abort must not hold up a replacement account epoch.
  queues.clear();
  for (const entry of cooling.values()) clearTimeout(entry.timer);
  cooling.clear();
  for (const queue of previous) queue.controller.abort();
});

/** Social reads share an account transaction fence; queue them instead of creating a refresh stampede. */
export const socialReadRequest = <Output>(path: string, schema: z.ZodType<Output>, options: ApiRequestOptions & { accountViewer: string }): Promise<Output> => {
  const viewer = options.accountViewer;
  const isGet = options.method === undefined || options.method.toUpperCase() === 'GET';
  const queue = queues.get(viewer) ?? { tail: Promise.resolve(), controller: new AbortController() };
  queues.set(viewer, queue);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cancellation = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  queue.controller.signal.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted || queue.controller.signal.aborted) abort();
  const assertCurrent = () => controller.signal.throwIfAborted();
  const timeoutError = () => new ApiError('The Social read timed out.', 'network', undefined, 'social_read_timeout');
  const read = async (deadlineAt: number) => {
    for (let attempt = 0; ; attempt += 1) {
      assertCurrent();
      if (isGet) await waitForGetAdmission(viewer, controller.signal);
      if (performance.now() >= deadlineAt) controller.abort(timeoutError());
      assertCurrent();
      try {
        return await apiRequest(path, schema, { ...options, signal: controller.signal });
      } catch (error) {
        assertCurrent();
        if (isGet && error instanceof ApiError && error.status === 429) {
          coolSubsequentGets(viewer, error.retryAfterSeconds);
        }
        if (attempt >= 2 || !isGet || !(error instanceof ApiError)) throw error;
        const contention = error.status === 503 && ['social_unavailable', 'room_unavailable'].includes(error.code ?? '');
        // A known concurrency denial can recover inside this read's original deadline; quota/unknown denials stay explicit.
        const admission = error.kind === 'http' && error.status === 429 && error.code === undefined
          && error.message === 'Too many concurrent requests.'
          && Number.isInteger(error.retryAfterSeconds) && (error.retryAfterSeconds ?? 0) > 0
          && (cooling.get(viewer)?.deadline ?? Infinity) < deadlineAt;
        if (!contention && !admission) throw error;
        if (contention) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 100));
      }
    }
  };
  const work = queue.tail.catch(() => undefined).then(async () => {
    assertCurrent();
    if (isGet) await waitForGetAdmission(viewer, controller.signal);
    assertCurrent();
    const deadlineAt = performance.now() + activeReadDeadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError();
        controller.abort(error); reject(error);
      }, activeReadDeadlineMs);
    });
    try { return await Promise.race([read(deadlineAt), deadline]); }
    finally { clearTimeout(timer); }
  }).finally(() => {
    options.signal?.removeEventListener('abort', abort);
    queue.controller.signal.removeEventListener('abort', abort);
    if (queues.get(viewer) === queue && queue.tail === work) queues.delete(viewer);
  });
  queue.tail = work;
  // Cancellation is immediate for the caller. The queue slot survives until the
  // transport settles or its deadline, so cancellation cannot bypass serialization.
  return Promise.race([work, cancellation]);
};
