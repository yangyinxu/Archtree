import { useQuery, useQueryClient } from '@tanstack/react-query';

import { browserSessionQuery } from '../../api/session';
import { rememberSearchQuery } from './searchHistory';

/** Defers explicit history writes until the browser account identity is known. */
export const useSearchHistoryRecorder = () => {
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.isSuccess ? (session.data?.user.id ?? null) : undefined;

  const recordSubmittedQuery = (query: string) => {
    const normalized = query.trim();
    if (!normalized) return;
    if (session.isSuccess) {
      rememberSearchQuery(session.data?.user.id ?? null, normalized);
    } else {
      void queryClient.fetchQuery(browserSessionQuery())
        .then((resolvedSession) => {
          rememberSearchQuery(resolvedSession?.user.id ?? null, normalized);
        })
        .catch(() => {
          // Public Search continues without history when account identity cannot resolve safely.
        });
    }
  };

  return {
    historyIsReady: session.isSuccess,
    recordSubmittedQuery,
    viewerId
  };
};
