import { queryOptions } from '@tanstack/react-query';

import {
  ApiError,
  apiRequest,
  apiRequestNoContent,
  recoverBrowserSessionIdentityConflict
} from './client';
import {
  captureAccountOperation,
  isAccountOperationCurrent,
  type AccountOperationGuard
} from './accountEpoch';
import {
  browserSessionSchema,
  loginInputSchema,
  type BrowserSession,
  type LoginInput
} from './schemas';
import { publishAccountSessionChange } from './accountSessionEvents';

export const browserSessionQueryKey = ['browser-session'] as const;
export const browserSessionResolvingQueryKey = ['browser-session', 'resolving'] as const;

interface BrowserLoginTransitionResult {
  session: BrowserSession;
  guard: AccountOperationGuard;
}

/** Resolves signed-out as null while preserving network and contract failures. */
export const getBrowserSession = async (): Promise<BrowserSession | null> => {
  try {
    return await apiRequest('/auth/browser/session', browserSessionSchema, {
      bootstrapBrowserSession: true
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    if (error instanceof ApiError && error.code === 'browser_session_identity_conflict') {
      const { runBrowserSessionTransition } = await import('./sessionTransition');
      await runBrowserSessionTransition(
        { kind: 'logout', changesIdentity: true },
        recoverBrowserSessionIdentityConflict
      );
      return null;
    }
    throw error;
  }
};

export const browserSessionQuery = () => queryOptions({
  queryKey: browserSessionQueryKey,
  queryFn: getBrowserSession,
  retry: false,
  staleTime: 2 * 60 * 1000
});

/** Exposes account reconciliation without issuing a second network request. */
export const browserSessionResolvingQuery = () => queryOptions({
  queryKey: browserSessionResolvingQueryKey,
  queryFn: () => false,
  enabled: false,
  initialData: false,
  staleTime: Infinity
});

/** Establishes an HttpOnly-cookie session without exposing either token. */
export const loginBrowserSession = async (input: LoginInput) => {
  const credentials = loginInputSchema.parse(input);
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  return runBrowserSessionTransition<BrowserLoginTransitionResult>({
    kind: 'login',
    changesIdentity: true,
    onConflict: async (result) => {
      if (result) await logoutBrowserSessionUnlocked(result.session.user.id);
    }
  }, async (_capability, generation) => {
    const session = await apiRequest('/auth/browser/login', browserSessionSchema, {
      method: 'POST',
      body: JSON.stringify(credentials),
      headers: { 'X-Finitude-Session-Transition': 'web-locks-v1' },
      retryAuthentication: false
    });
    const guard = captureAccountOperation(session.user.id, generation);
    if (isAccountOperationCurrent(guard)) publishAccountSessionChange('login');
    return { session, guard };
  });
};

/** Clears cookies inside an already-held transition without acquiring a nested lock. */
export const logoutBrowserSessionUnlocked = (
  viewerId: string,
  transitionCapability?: 'web-locks-v1'
) => apiRequestNoContent(
  '/auth/browser/logout',
  {
    method: 'POST',
    body: '{}',
    headers: transitionCapability
      ? { 'X-Finitude-Session-Transition': transitionCapability }
      : undefined,
    accountViewer: viewerId,
    retryAuthentication: false
  }
);

/** Revokes the rotating session and clears both browser cookies server-side. */
export const logoutBrowserSession = async (viewerId: string) => {
  const { runBrowserSessionTransition } = await import('./sessionTransition');
  return runBrowserSessionTransition({
    kind: 'logout',
    changesIdentity: true,
    onConflict: () => logoutBrowserSessionUnlocked(viewerId)
  }, async (capability, generation) => {
    await logoutBrowserSessionUnlocked(viewerId, capability);
    publishAccountSessionChange('logout');
    return captureAccountOperation(viewerId, generation);
  });
};
