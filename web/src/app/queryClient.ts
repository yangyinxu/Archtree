import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';

/** Shares server state across routes without treating player state as API data. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status && error.status < 500) return false;
        return failureCount < 1;
      }
    },
    mutations: {
      retry: false
    }
  }
});
