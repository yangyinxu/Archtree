import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestNoContent } from './client';
import {
  acceptedAuthenticationActionSchema,
  accountSessionsSchema,
  browserAuthenticationCapabilitiesSchema,
  changePasswordInputSchema,
  emailActionInputSchema,
  registerInputSchema,
  resetPasswordInputSchema,
  verificationInputSchema,
  type ChangePasswordInput,
  type EmailActionInput,
  type RegisterInput,
  type ResetPasswordInput,
  type VerificationInput
} from './schemas';

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

/** Starts verification with a response that is identical for new and existing addresses. */
export const registerBrowserAccount = (input: RegisterInput) => {
  const body = registerInputSchema.parse(input);
  return apiRequest('/auth/browser/register', acceptedAuthenticationActionSchema, {
    method: 'POST',
    body: JSON.stringify(body),
    retryAuthentication: false
  });
};

export const verifyBrowserEmail = (input: VerificationInput) => {
  const body = verificationInputSchema.parse(input);
  return apiRequestNoContent('/auth/browser/email/verify', {
    method: 'POST',
    body: JSON.stringify(body),
    retryAuthentication: false
  });
};

/** Requests another code without allowing the response to enumerate accounts. */
export const resendBrowserVerification = (input: EmailActionInput) => {
  const body = emailActionInputSchema.parse(input);
  return apiRequest(
    '/auth/browser/email/resend-verification',
    acceptedAuthenticationActionSchema,
    {
      method: 'POST',
      body: JSON.stringify(body),
      retryAuthentication: false
    }
  );
};

/** Starts password recovery with the same response for every valid address. */
export const requestBrowserPasswordReset = (input: EmailActionInput) => {
  const body = emailActionInputSchema.parse(input);
  return apiRequest('/auth/browser/password/forgot', acceptedAuthenticationActionSchema, {
    method: 'POST',
    body: JSON.stringify(body),
    retryAuthentication: false
  });
};

export const resetBrowserPassword = (input: ResetPasswordInput) => {
  const body = resetPasswordInputSchema.parse(input);
  return apiRequestNoContent('/auth/browser/password/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    retryAuthentication: false
  });
};

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
