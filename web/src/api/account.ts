import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestNoContent } from './client';
import {
  accountSessionsSchema,
  browserAuthenticationCapabilitiesSchema,
  changePasswordInputSchema,
  type ChangePasswordInput
} from './accountSchemas';

export const browserAuthenticationCapabilitiesQueryKey = ['auth', 'browser-capabilities'] as const;

/** Reads browser-specific capabilities so native provider configuration cannot leak into Web UI. */
export const getBrowserAuthenticationCapabilities = () => apiRequest(
  '/auth/browser/capabilities',
  browserAuthenticationCapabilitiesSchema,
  { retryAuthentication: false }
);

export const browserAuthenticationCapabilitiesQuery = () => queryOptions({
  queryKey: browserAuthenticationCapabilitiesQueryKey,
  queryFn: getBrowserAuthenticationCapabilities,
  retry: false,
  staleTime: 5 * 60 * 1000
});

export const accountSessionsQueryKey = (viewerId: string) => ['account', viewerId, 'sessions'] as const;

/** Keeps active-session data in a viewer-keyed cache to prevent account crossover. */
export const listAccountSessions = (viewerId: string, signal?: AbortSignal) => apiRequest(
  '/auth/sessions',
  accountSessionsSchema,
  { accountViewer: viewerId, signal }
).then((result) => ({ viewerId, sessions: result.sessions }));

export const accountSessionsQuery = (viewerId: string) => queryOptions({
  queryKey: accountSessionsQueryKey(viewerId),
  queryFn: ({ signal }) => listAccountSessions(viewerId, signal),
  enabled: Boolean(viewerId),
  retry: false
});

export const revokeAccountSession = (viewerId: string, sessionId: string) => apiRequestNoContent(
  `/auth/sessions/${encodeURIComponent(sessionId)}`,
  { method: 'DELETE', accountViewer: viewerId }
);

export const changeAccountPassword = (viewerId: string, input: ChangePasswordInput) => {
  const body = changePasswordInputSchema.parse(input);
  return apiRequestNoContent('/auth/password/change', {
    method: 'POST',
    body: JSON.stringify(body),
    accountViewer: viewerId
  });
};
