import type { z } from 'zod';
import { apiRequest, ApiError, type ApiRequestOptions } from './client';
import { subscribeToAccountEpoch } from './accountEpoch';

interface ReadQueue { tail: Promise<unknown>; controller: AbortController }
const queues = new Map<string, ReadQueue>();
const activeReadDeadlineMs = 30_000;

subscribeToAccountEpoch(() => {
  const previous = [...queues.values()];
  // A transport that ignores abort must not hold up a replacement account epoch.
  queues.clear();
  for (const queue of previous) queue.controller.abort();
});

/** Social reads share an account transaction fence; queue them instead of creating a refresh stampede. */
export const socialReadRequest = <Output>(path: string, schema: z.ZodType<Output>, options: ApiRequestOptions & { accountViewer: string }): Promise<Output> => {
  const viewer = options.accountViewer;
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
  const read = async () => {
    for (let attempt = 0; ; attempt += 1) {
      assertCurrent();
      try {
        return await apiRequest(path, schema, { ...options, signal: controller.signal });
      } catch (error) {
        assertCurrent();
        // Only read-only transaction contention is retried; quota and mutation outcomes remain explicit.
        if (attempt >= 2 || options.method && options.method !== 'GET' || !(error instanceof ApiError)
          || error.status !== 503 || !['social_unavailable', 'room_unavailable'].includes(error.code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 100));
      }
    }
  };
  const work = queue.tail.catch(() => undefined).then(async () => {
    assertCurrent();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ApiError('The Social read timed out.', 'network', undefined, 'social_read_timeout');
        controller.abort(error); reject(error);
      }, activeReadDeadlineMs);
    });
    try { return await Promise.race([read(), deadline]); }
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
