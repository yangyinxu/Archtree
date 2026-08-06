import type { QueryClient } from '@tanstack/react-query';

import { browserSessionQuery } from '../api/session';
import { clearSearchHistory } from '../features/search/searchHistory';

/** Finishes detached account reconciliation outside the initial listener bundle. */
export const resolveAccountSessionChange = async (
  queryClient: QueryClient,
  _event: unknown,
  previousViewerId?: string
) => {
  try {
    const next = await queryClient.fetchQuery({
      ...browserSessionQuery(),
      staleTime: 0
    });
    if (previousViewerId && next?.user.id !== previousViewerId) {
      clearSearchHistory(previousViewerId);
    }
  } catch {
    // The authoritative session query retains its bounded error for the UI to retry.
  }
};
