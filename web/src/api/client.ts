import { z } from 'zod';

import { apiErrorPayloadSchema, browserSessionSchema } from './schemas';
import { enqueueListenerTelemetry } from '../telemetry/client';
import {
  classifyApiOperation,
  classifyListenerRoute,
  statusBucket
} from '../telemetry/routeClassifier';
import { publishAccountSessionChange } from './accountSessionEvents';
import type { BrowserSessionTransitionScope } from './sessionTransition';
import {
  advanceAccountEpoch,
  captureAccountOperation,
  isAccountOperationCurrent,
  type AccountOperationGuard
} from './accountEpoch';

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
  /** Binds a private Web response to the same viewer that keyed its cache. */
  accountViewer?: string;
  /** Allows only the authoritative browser-session bootstrap to rotate without a known viewer. */
  bootstrapBrowserSession?: boolean;
  /** Reuses an active caller-owned lock instead of queuing a nested refresh. */
  sessionTransition?: BrowserSessionTransitionScope;
}

let authGeneration = 0;
let refreshInFlight: { key: string; promise: Promise<boolean> } | null = null;

const reportTerminalApiFailure = (
  path: string,
  method: string | undefined,
  error: unknown,
  attempt: 'initial' | 'after_refresh'
) => {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  const operation = classifyApiOperation(path, method);
  if (!operation || !(error instanceof ApiError)) return;
  enqueueListenerTelemetry({
    category: 'api_error',
    operation,
    kind: error.kind === 'invalid-response' ? 'invalid_response' : error.kind,
    statusBucket: error.kind === 'http' ? statusBucket(error.status) : 'none',
    route: classifyListenerRoute(
      typeof window === 'undefined' ? '/finitude' : window.location.pathname
    ),
    attempt
  });
};

const requestHeaders = (init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
};

const responseError = async (response: Response, assertCurrent?: () => void) => {
  assertCurrent?.();
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

  // Reading an error body is asynchronous too; stale errors cannot trigger reconciliation.
  assertCurrent?.();
  if (response.status === 409 && code === 'account_viewer_mismatch') {
    publishAccountSessionChange('viewer-mismatch');
  }

  return new ApiError(message, 'http', response.status, code);
};

const fetchResponse = async (path: string, init?: RequestInit, accountViewer?: string) => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError('API requests must use a same-origin path.', 'network');
  }

  try {
    const headers = requestHeaders(init);
    if (accountViewer) headers.set('X-Finitude-Account-Viewer', accountViewer);
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers
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

const assertAccountBoundResponse = (response: Response, accountViewer?: string) => {
  if (!accountViewer) return;
  const returned = response.headers.get('X-Finitude-Account-Viewer')?.trim();
  if (returned === accountViewer) return;
  publishAccountSessionChange('viewer-mismatch');
  throw new ApiError(
    'The active account changed. Refresh the account before trying again.',
    'invalid-response',
    409,
    'account_viewer_mismatch'
  );
};

const assertAccountEpoch = (guard?: AccountOperationGuard) => {
  if (!guard || isAccountOperationCurrent(guard)) return;
  throw new ApiError(
    'The active account changed. Refresh the account before trying again.',
    'invalid-response',
    409,
    'account_viewer_mismatch'
  );
};

const requestOnce = async <Output>(
  path: string,
  schema: z.ZodType<Output>,
  init?: RequestInit,
  accountViewer?: string,
  assertCurrent?: () => void
) => {
  const response = await fetchResponse(path, init, accountViewer);
  assertCurrent?.();
  if (!response.ok) throw await responseError(response, assertCurrent);
  assertAccountBoundResponse(response, accountViewer);
  return parseJson(response, schema);
};

const readCurrentBrowserSession = async (assertCurrent?: () => void) => {
  try {
    return await requestOnce('/auth/browser/session', browserSessionSchema, undefined, undefined, assertCurrent);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
};

const isBrowserSessionIdentityConflict = (error: unknown) => error instanceof ApiError
  && error.status === 409
  && error.code === 'browser_session_identity_conflict';

/** Clears conflicting credentials before one identity can consume another identity's cache. */
export const recoverBrowserSessionIdentityConflict = async (
  transitionCapability: 'web-locks-v1' | undefined
) => {
  advanceAccountEpoch();
  const response = await fetchResponse('/auth/browser/logout', {
    method: 'POST',
    body: '{}',
    headers: transitionCapability
      ? { 'X-Finitude-Session-Transition': transitionCapability }
      : undefined
  });
  if (!response.ok) throw await responseError(response);
  if (response.status !== 204) {
    throw new ApiError('The server returned an unexpected response.', 'invalid-response', response.status);
  }
  publishAccountSessionChange('logout', { includeCurrentTab: true });
};

const adoptUnboundBrowserSession = () => {
  advanceAccountEpoch();
  publishAccountSessionChange('login', { includeCurrentTab: true });
};

const rotateBrowserSession = async (expectedViewer?: string, assertCurrent?: () => void) => {
  const response = await fetchResponse('/auth/browser/refresh', {
    method: 'POST',
    body: '{}',
    headers: { 'X-Finitude-Session-Transition': 'web-locks-v1' }
  }, expectedViewer);
  assertCurrent?.();
  if (!response.ok) throw await responseError(response, assertCurrent);
  const session = await parseJson(response, browserSessionSchema);
  const returnedViewer = response.headers.get('X-Finitude-Account-Viewer')?.trim();
  if (!returnedViewer
    || returnedViewer !== session.user.id
    || (expectedViewer && returnedViewer !== expectedViewer)) {
    throw new ApiError(
      'The active account changed. Refresh the account before trying again.',
      'invalid-response',
      409,
      'browser_session_identity_conflict'
    );
  }
  return session;
};

/** Recovers authentication inside the caller's live lock, never by acquiring it again. */
const refreshBrowserSessionWhileLocked = async (
  expectedViewer: string | undefined,
  bootstrapBrowserSession: boolean,
  scope: BrowserSessionTransitionScope,
  guard: AccountOperationGuard
) => {
  const assertCurrent = () => {
    scope.assertActive();
    assertAccountEpoch(guard);
  };
  assertCurrent();
  // Cleanup can use the storage fallback, but installing credentials still requires Web Locks.
  if (!scope.capability) return false;
  const recoverConflict = async () => {
    assertCurrent();
    await recoverBrowserSessionIdentityConflict(scope.capability);
    return false;
  };
  let current;
  try {
    current = await readCurrentBrowserSession(assertCurrent);
  } catch (error) {
    assertCurrent();
    if (isBrowserSessionIdentityConflict(error)) return recoverConflict();
    throw error;
  }
  assertCurrent();
  if (current) {
    if (expectedViewer && current.user.id !== expectedViewer) return recoverConflict();
    if (!expectedViewer) adoptUnboundBrowserSession();
    return true;
  }
  if (!expectedViewer && !bootstrapBrowserSession) return false;
  try {
    assertCurrent();
    await rotateBrowserSession(expectedViewer, assertCurrent);
    assertCurrent();
    if (!expectedViewer) adoptUnboundBrowserSession();
    return true;
  } catch (error) {
    assertCurrent();
    if (isBrowserSessionIdentityConflict(error)) return recoverConflict();
    if (error instanceof ApiError && error.status === 401) {
      // Another tab can consume the rotating token just before this request.
      const winner = await readCurrentBrowserSession(assertCurrent);
      assertCurrent();
      if (!winner) return false;
      if (expectedViewer && winner.user.id !== expectedViewer) return recoverConflict();
      if (!expectedViewer) adoptUnboundBrowserSession();
      return true;
    }
    throw error;
  }
};

/** Rechecks the operation epoch after waiting so an old tab request cannot clear a new session. */
const coordinateBrowserSessionRefresh = async (
  expectedViewer: string | undefined,
  bootstrapBrowserSession: boolean,
  guard: AccountOperationGuard
) => {
  const transition = await import('./sessionTransition');
  assertAccountEpoch(guard);
  try {
    return await transition.runBrowserSessionTransition(
      { kind: 'refresh' },
      (_capability, _generation, scope) => refreshBrowserSessionWhileLocked(
        expectedViewer, bootstrapBrowserSession, scope, guard
      )
    );
  } catch (error) {
    if (error instanceof transition.BrowserSessionTransitionUnavailableError
      || error instanceof transition.BrowserSessionTransitionConflictError) return false;
    throw error;
  }
};

/** Coalesces failures in this tab while Web Locks coordinate all same-origin tabs. */
const refreshAfter = (
  observedGeneration: number,
  expectedViewer: string | undefined,
  bootstrapBrowserSession: boolean,
  guard: AccountOperationGuard,
  scope?: BrowserSessionTransitionScope
) => {
  assertAccountEpoch(guard);
  if (scope) {
    // A queued refresh can itself be waiting for this scope; joining it would also deadlock.
    return refreshBrowserSessionWhileLocked(expectedViewer, bootstrapBrowserSession, scope, guard)
      .then((refreshed) => {
        if (refreshed) authGeneration += 1;
        return refreshed;
      });
  }
  if (observedGeneration !== authGeneration) return Promise.resolve(true);
  const key = JSON.stringify([guard.epoch, expectedViewer, bootstrapBrowserSession]);
  if (!refreshInFlight || refreshInFlight.key !== key) {
    const entry = {
      key,
      promise: coordinateBrowserSessionRefresh(expectedViewer, bootstrapBrowserSession, guard)
        .then((refreshed) => {
          if (refreshed) authGeneration += 1;
          return refreshed;
        })
        .finally(() => {
          if (refreshInFlight === entry) refreshInFlight = null;
        })
    };
    refreshInFlight = entry;
  }
  return refreshInFlight.promise;
};

/** Requests and validates JSON, retrying exactly once after cookie rotation. */
export const apiRequest = async <Output>(
  path: string,
  schema: z.ZodType<Output>,
  options: ApiRequestOptions = {}
) => {
  const {
    retryAuthentication = true,
    accountViewer,
    bootstrapBrowserSession = false,
    sessionTransition,
    ...init
  } = options;
  const viewer = accountViewer?.trim() || undefined;
  const accountGuard = viewer ? captureAccountOperation(viewer) : undefined;
  const refreshGuard = accountGuard ?? captureAccountOperation('');
  const observedGeneration = authGeneration;
  const assertCurrent = () => {
    sessionTransition?.assertActive();
    assertAccountEpoch(accountGuard);
    init.signal?.throwIfAborted();
  };

  try {
    assertCurrent();
    const result = await requestOnce(path, schema, init, viewer, assertCurrent);
    assertAccountEpoch(accountGuard);
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !retryAuthentication) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw error;
    }

    let refreshed: boolean;
    try {
      assertCurrent();
      refreshed = await refreshAfter(
        observedGeneration, viewer, bootstrapBrowserSession, refreshGuard, sessionTransition
      );
    } catch (refreshError) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw refreshError;
    }
    if (!refreshed) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw error;
    }
    try {
      assertCurrent();
      const result = await requestOnce(path, schema, init, viewer, assertCurrent);
      assertAccountEpoch(accountGuard);
      return result;
    } catch (retryError) {
      reportTerminalApiFailure(path, init.method, retryError, 'after_refresh');
      throw retryError;
    }
  }
};

/** Performs a validated mutation whose successful contract has no body. */
export const apiRequestNoContent = async (
  path: string,
  options: ApiRequestOptions = {}
) => {
  const {
    retryAuthentication = true,
    accountViewer,
    bootstrapBrowserSession = false,
    sessionTransition,
    ...init
  } = options;
  const viewer = accountViewer?.trim() || undefined;
  const accountGuard = viewer ? captureAccountOperation(viewer) : undefined;
  const refreshGuard = accountGuard ?? captureAccountOperation('');
  const observedGeneration = authGeneration;
  const assertCurrent = () => {
    sessionTransition?.assertActive();
    assertAccountEpoch(accountGuard);
    init.signal?.throwIfAborted();
  };

  const run = async () => {
    assertCurrent();
    const response = await fetchResponse(path, init, viewer);
    assertCurrent();
    if (!response.ok) throw await responseError(response, assertCurrent);
    assertAccountBoundResponse(response, viewer);
    if (response.status !== 204) {
      throw new ApiError('The server returned an unexpected response.', 'invalid-response', response.status);
    }
    assertAccountEpoch(accountGuard);
  };

  try {
    await run();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !retryAuthentication) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw error;
    }
    let refreshed: boolean;
    try {
      assertCurrent();
      refreshed = await refreshAfter(
        observedGeneration, viewer, bootstrapBrowserSession, refreshGuard, sessionTransition
      );
    } catch (refreshError) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw refreshError;
    }
    if (!refreshed) {
      reportTerminalApiFailure(path, init.method, error, 'initial');
      throw error;
    }
    try {
      await run();
    } catch (retryError) {
      reportTerminalApiFailure(path, init.method, retryError, 'after_refresh');
      throw retryError;
    }
  }
};
