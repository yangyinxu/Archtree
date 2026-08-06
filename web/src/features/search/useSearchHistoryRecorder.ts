import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  captureAccountOperation,
  isAccountOperationCurrent
} from '../../api/accountEpoch';
import type { BrowserSession } from '../../api/schemas';
import {
  browserSessionQuery,
  browserSessionQueryKey,
  browserSessionResolvingQuery,
  browserSessionResolvingQueryKey
} from '../../api/session';
import { rememberSearchQuery } from './searchHistory';

/** Defers explicit history writes until the browser account identity is known. */
export const useSearchHistoryRecorder = () => {
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const viewerId = session.isSuccess && !resolving.data
    ? (session.data?.user.id ?? null)
    : undefined;

  const mayRecordFor = (guard: ReturnType<typeof captureAccountOperation>, accountId: string | null) => {
    if (!isAccountOperationCurrent(guard)) return false;
    if (queryClient.getQueryData<boolean>(browserSessionResolvingQueryKey)) return false;
    const current = queryClient.getQueryData<BrowserSession | null>(browserSessionQueryKey);
    return (current?.user.id ?? null) === accountId;
  };

  const recordSubmittedQuery = (query: string) => {
    const normalized = query.trim();
    if (!normalized || resolving.data) return;
    if (session.isSuccess) {
      const accountId = session.data?.user.id ?? null;
      const guard = captureAccountOperation(accountId ?? 'anonymous');
      if (mayRecordFor(guard, accountId)) rememberSearchQuery(accountId, normalized);
    } else {
      const guard = captureAccountOperation('pending-viewer');
      void queryClient.fetchQuery(browserSessionQuery())
        .then((resolvedSession) => {
          const accountId = resolvedSession?.user.id ?? null;
          if (mayRecordFor(guard, accountId)) rememberSearchQuery(accountId, normalized);
        })
        .catch(() => {
          // Public Search continues without history when account identity cannot resolve safely.
        });
    }
  };

  return {
    historyIsReady: session.isSuccess && !resolving.data,
    recordSubmittedQuery,
    viewerId
  };
};
