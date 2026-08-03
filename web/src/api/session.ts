import { queryOptions } from '@tanstack/react-query';

import { ApiError, apiRequest, apiRequestNoContent } from './client';
import {
  browserSessionSchema,
  loginInputSchema,
  type BrowserSession,
  type LoginInput
} from './schemas';

export const browserSessionQueryKey = ['browser-session'] as const;

/** Resolves signed-out as null while preserving network and contract failures. */
export const getBrowserSession = async (): Promise<BrowserSession | null> => {
  try {
    return await apiRequest('/auth/browser/session', browserSessionSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
};

export const browserSessionQuery = () => queryOptions({
  queryKey: browserSessionQueryKey,
  queryFn: getBrowserSession,
  retry: false,
  staleTime: 2 * 60 * 1000
});

/** Establishes an HttpOnly-cookie session without exposing either token. */
export const loginBrowserSession = (input: LoginInput) => {
  const credentials = loginInputSchema.parse(input);
  return apiRequest('/auth/browser/login', browserSessionSchema, {
    method: 'POST',
    body: JSON.stringify(credentials),
    retryAuthentication: false
  });
};

/** Revokes the rotating session and clears both browser cookies server-side. */
export const logoutBrowserSession = (viewerId?: string) => apiRequestNoContent('/auth/browser/logout', {
  method: 'POST',
  body: '{}',
  headers: viewerId ? { 'X-Finitude-Account-Viewer': viewerId } : undefined,
  retryAuthentication: false
});
