import { queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';

import { ApiError, apiRequest, apiRequestNoContent } from './client';
import {
  acceptedAuthenticationActionSchema,
  accountSessionsSchema,
  browserAuthenticationCapabilitiesSchema,
  changePasswordInputSchema,
  completeRegistrationInputSchema,
  emailActionInputSchema,
  emailLinkAddressSchema,
  emailLinkTokenInputSchema,
  resetPasswordInputSchema,
  type ChangePasswordInput,
  type CompleteRegistrationInput,
  type EmailActionInput,
  type EmailLinkTokenInput,
  type ResetPasswordInput
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

/** Posts one validated JSON body to a public browser account endpoint that never refreshes cookies. */
const postAccountAction = <Output>(path: string, body: unknown, schema: z.ZodType<Output>) => apiRequest(
  path,
  schema,
  { method: 'POST', body: JSON.stringify(body), retryAuthentication: false }
);

/**
 * An accepted registration, verification-link or recovery request with the
 * address it carried: trimmed and lowercased, exactly what the server sends
 * to, so a page can show it and a mistyped address is easy to spot.
 */
export interface AcceptedEmailRequest {
  message: string;
  email: string;
}

/**
 * Posts a request that emails the submitted address. The input is validated
 * synchronously, so an invalid body throws before any request.
 */
const postEmailRequest = (path: string, input: EmailActionInput): Promise<AcceptedEmailRequest> => {
  const body = emailActionInputSchema.parse(input);
  return postAccountAction(path, body, acceptedAuthenticationActionSchema)
    .then(({ message }) => ({ message, email: body.email }));
};

/** The `422` code for an address whose domain cannot receive email. */
export const emailDomainUndeliverableCode = 'email_domain_undeliverable';

/**
 * Recognizes the `422 email_domain_undeliverable` rejection of a registration,
 * verification-link or recovery request. The server decides it only from the
 * domain's public DNS, never from account state, so a page may show it as an
 * error on the email field. Other `422` responses (invalid input) do not match.
 */
export const isEmailDomainUndeliverable = (error: unknown) => error instanceof ApiError
  && error.kind === 'http'
  && error.status === 422
  && error.code === emailDomainUndeliverableCode;

/**
 * Requests a registration email. The response is identical for every account
 * state: the email holds either a registration link or an "already registered"
 * notice, so the page never learns which one was sent. Only an address whose
 * domain cannot receive email is rejected (see `isEmailDomainUndeliverable`).
 */
export const requestBrowserRegistration = (input: EmailActionInput) => postEmailRequest(
  '/auth/browser/registration/request',
  input
);

/** Reads the address a registration link was mailed to without consuming the link. */
export const inspectBrowserRegistration = (input: EmailLinkTokenInput) => postAccountAction(
  '/auth/browser/registration/inspect',
  emailLinkTokenInputSchema.parse(input),
  emailLinkAddressSchema
);

/** Creates the verified account from a registration link; it installs no session. */
export const completeBrowserRegistration = (input: CompleteRegistrationInput) => postAccountAction(
  '/auth/browser/registration/complete',
  completeRegistrationInputSchema.parse(input),
  emailLinkAddressSchema
);

/**
 * Requests a verification link without revealing whether the address needs
 * one; only an undeliverable domain is rejected.
 */
export const requestBrowserEmailVerification = (input: EmailActionInput) => postEmailRequest(
  '/auth/browser/email-verification/request',
  input
);

/** Reads the address a verification link would verify without consuming the link. */
export const inspectBrowserEmailVerification = (input: EmailLinkTokenInput) => postAccountAction(
  '/auth/browser/email-verification/inspect',
  emailLinkTokenInputSchema.parse(input),
  emailLinkAddressSchema
);

/** Verifies the email after an explicit click; the password and other sessions stay unchanged. */
export const confirmBrowserEmailVerification = (input: EmailLinkTokenInput) => {
  const body = emailLinkTokenInputSchema.parse(input);
  return apiRequestNoContent('/auth/browser/email-verification/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
    retryAuthentication: false
  });
};

/**
 * Starts password recovery with the same response for every valid address;
 * only an undeliverable domain is rejected.
 */
export const requestBrowserPasswordReset = (input: EmailActionInput) => postEmailRequest(
  '/auth/browser/password/forgot',
  input
);

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
