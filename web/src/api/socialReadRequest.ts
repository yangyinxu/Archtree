import type { z } from 'zod';
import { apiRequest, ApiError, type ApiRequestOptions } from './client';
import { captureAccountOperation, isAccountOperationCurrent } from './accountEpoch';

const pending = new Map<string, Promise<unknown>>();

/** Social reads share an account transaction fence; queue them instead of creating a refresh stampede. */
export const socialReadRequest = <Output>(path: string, schema: z.ZodType<Output>, options: ApiRequestOptions & { accountViewer: string }): Promise<Output> => {
  const viewer = options.accountViewer;
  const guard = captureAccountOperation(viewer);
  const result = (pending.get(viewer) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (!isAccountOperationCurrent(guard) || options.signal?.aborted) throw new DOMException('Account read canceled.', 'AbortError');
      try { return await apiRequest(path, schema, options); }
      catch (error) {
        // Only read-only transaction contention is retried; quota and mutation outcomes remain explicit.
        if (attempt >= 2 || options.method && options.method !== 'GET' || !(error instanceof ApiError)
          || error.status !== 503 || !['social_unavailable', 'room_unavailable'].includes(error.code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 100));
      }
    }
  });
  pending.set(viewer, result);
  void result.finally(() => { if (pending.get(viewer) === result) pending.delete(viewer); }).catch(() => undefined);
  return result;
};
