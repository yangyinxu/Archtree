import { z } from 'zod';

import { apiErrorPayloadSchema, browserSessionSchema } from './schemas';

export type ApiErrorKind = 'http' | 'network' | 'invalid-response';

/** Describes a safe client-facing failure without retaining response bodies. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends RequestInit {
  /** Login and refresh must opt out to avoid recursive refresh attempts. */
  retryAuthentication?: boolean;
}

let authGeneration = 0;
let refreshInFlight: Promise<boolean> | null = null;
const browserRefreshLockName = 'finitude:browser-session-refresh';

interface BrowserLockManager {
  request<Output>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<Output>
  ): Promise<Output>;
}

const requestHeaders = (init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
};

const responseError = async (response: Response) => {
  let message = response.status === 401
    ? 'Your listening session has expired.'
    : 'Finitude could not complete that request.';
  let code: string | undefined;

  try {
    const parsed = apiErrorPayloadSchema.safeParse(await response.json());
    if (parsed.success) {
      message = parsed.data.message ?? parsed.data.error ?? message;
      code = parsed.data.code;
    }
  } catch {
    // Non-JSON error pages are reduced to the bounded fallback above.
  }

  return new ApiError(message, 'http', response.status, code);
};

const fetchResponse = async (path: string, init?: RequestInit) => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError('API requests must use a same-origin path.', 'network');
  }

  try {
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: requestHeaders(init)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Finitude is having trouble reaching the server.', 'network');
  }
};

const parseJson = async <Output>(response: Response, schema: z.ZodType<Output>) => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('The server returned an unreadable response.', 'invalid-response', response.status);
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError('The server returned an unexpected response.', 'invalid-response', response.status);
  }
  return result.data;
};

const requestOnce = async <Output>(
  path: string,
  schema: z.ZodType<Output>,
  init?: RequestInit
) => {
  const response = await fetchResponse(path, init);
  if (!response.ok) throw await responseError(response);
  return parseJson(response, schema);
};

const hasCurrentBrowserSession = async () => {
  try {
    await requestOnce('/auth/browser/session', browserSessionSchema);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false;
    throw error;
  }
};

const rotateBrowserSession = async () => {
  try {
    await requestOnce('/auth/browser/refresh', browserSessionSchema, {
      method: 'POST',
      body: '{}'
    });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // Another tab can win the rotation just before this request consumes the old cookie.
      return hasCurrentBrowserSession();
    }
    throw error;
  }
};

const runWithBrowserRefreshLock = <Output>(operation: () => Promise<Output>) => {
  if (typeof navigator === 'undefined') return operation();
  const lockManager = (navigator as Navigator & { locks?: BrowserLockManager }).locks;
  if (!lockManager) return operation();
  return lockManager.request(browserRefreshLockName, { mode: 'exclusive' }, operation);
};

/** Rechecks the shared cookie after waiting so only one tab rotates it. */
const coordinateBrowserSessionRefresh = () => runWithBrowserRefreshLock(async () => {
  if (await hasCurrentBrowserSession()) return true;
  return rotateBrowserSession();
});

/** Coalesces failures in this tab while Web Locks coordinate all same-origin tabs. */
const refreshAfter = (observedGeneration: number) => {
  if (observedGeneration !== authGeneration) return Promise.resolve(true);
  if (!refreshInFlight) {
    refreshInFlight = coordinateBrowserSessionRefresh()
      .then((refreshed) => {
        if (refreshed) authGeneration += 1;
        return refreshed;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
};

/** Requests and validates JSON, retrying exactly once after cookie rotation. */
export const apiRequest = async <Output>(
  path: string,
  schema: z.ZodType<Output>,
  options: ApiRequestOptions = {}
) => {
  const { retryAuthentication = true, ...init } = options;
  const observedGeneration = authGeneration;

  try {
    return await requestOnce(path, schema, init);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !retryAuthentication) {
      throw error;
    }

    const refreshed = await refreshAfter(observedGeneration);
    if (!refreshed) throw error;
    return requestOnce(path, schema, init);
  }
};

/** Performs a validated mutation whose successful contract has no body. */
export const apiRequestNoContent = async (
  path: string,
  options: ApiRequestOptions = {}
) => {
  const { retryAuthentication = true, ...init } = options;
  const observedGeneration = authGeneration;

  const run = async () => {
    const response = await fetchResponse(path, init);
    if (!response.ok) throw await responseError(response);
    if (response.status !== 204) {
      throw new ApiError('The server returned an unexpected response.', 'invalid-response', response.status);
    }
  };

  try {
    await run();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !retryAuthentication) {
      throw error;
    }
    const refreshed = await refreshAfter(observedGeneration);
    if (!refreshed) throw error;
    await run();
  }
};
