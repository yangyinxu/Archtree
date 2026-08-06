import { type QueryClient } from '@tanstack/react-query';

import {
  publishAccountSessionChange,
  subscribeToAccountSessionChanges,
  type AccountSessionChangeEvent
} from '../api/accountSessionEvents';
import type { BrowserSession } from '../api/schemas';
import { advanceAccountEpoch } from '../api/accountEpoch';
import {
  browserSessionQueryKey,
  browserSessionResolvingQueryKey
} from '../api/session';

let privacyBarrierGeneration = 0;

/** Hides the rendered tree synchronously before account cache notifications can batch. */
const enterAccountPrivacyBarrier = () => {
  privacyBarrierGeneration += 1;
  document.getElementById('root')?.setAttribute('data-account-transitioning', 'true');
  return privacyBarrierGeneration;
};

const leaveAccountPrivacyBarrier = (generation: number) => {
  const schedule = window.requestAnimationFrame?.bind(window)
    ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  schedule(() => schedule(() => {
    if (generation === privacyBarrierGeneration) {
      document.getElementById('root')?.removeAttribute('data-account-transitioning');
    }
  }));
};

const reconcileOneAccountSessionChange = async (
  queryClient: QueryClient,
  event: AccountSessionChangeEvent
) => {
  advanceAccountEpoch();
  const previous = queryClient.getQueryData<BrowserSession | null>(browserSessionQueryKey);
  void queryClient.cancelQueries().catch(() => undefined);
  queryClient.setQueryData(browserSessionQueryKey, null);
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== browserSessionQueryKey[0]
  });
  const { resolveAccountSessionChange } = await import('./BrowserSessionReconciler');
  await resolveAccountSessionChange(queryClient, event, previous?.user.id);
};

/** Cancels old private reads before resolving the current shared-cookie identity. */
export const reconcileAccountSessionChange = async (
  queryClient: QueryClient,
  event: AccountSessionChangeEvent
) => {
  const privacyGeneration = enterAccountPrivacyBarrier();
  queryClient.setQueryData(browserSessionResolvingQueryKey, true);
  try {
    await reconcileOneAccountSessionChange(queryClient, event);
  } finally {
    queryClient.setQueryData(browserSessionResolvingQueryKey, false);
    leaveAccountPrivacyBarrier(privacyGeneration);
  }
};

/** Subscribes before first render and folds bursts into at most one trailing resolve. */
export const startBrowserSessionCoordinator = (queryClient: QueryClient) => {
  let active = false;
  let trailing: AccountSessionChangeEvent | undefined;
  let privacyGeneration = 0;
  const unsubscribe = subscribeToAccountSessionChanges((event) => {
    privacyGeneration = enterAccountPrivacyBarrier();
    trailing = event;
    if (active) return;
    active = true;
    queryClient.setQueryData(browserSessionResolvingQueryKey, true);
    void (async () => {
      try {
        while (trailing) {
          const next = trailing;
          trailing = undefined;
          await reconcileOneAccountSessionChange(queryClient, next);
        }
      } catch {
        // The authoritative session query preserves its bounded failure for retry.
      } finally {
        queryClient.setQueryData(browserSessionResolvingQueryKey, false);
        active = false;
        leaveAccountPrivacyBarrier(privacyGeneration);
      }
    })();
  });
  const location = new URL(window.location.href);
  if (location.searchParams.get('sessionTransition') === 'logout') {
    location.searchParams.delete('sessionTransition');
    window.history.replaceState(window.history.state, '', location);
    try {
      const pendingViewerKey = 'finitude:pending-logout-viewer';
      const viewerId = window.sessionStorage.getItem(pendingViewerKey)?.trim();
      window.sessionStorage.removeItem(pendingViewerKey);
      if (viewerId && viewerId.length <= 200) {
        window.localStorage.removeItem(`finitude:search-history:${viewerId}`);
      }
    } catch {
      // Account exit still reconciles when device-local storage is unavailable.
    }
    publishAccountSessionChange('logout');
  }
  return unsubscribe;
};
