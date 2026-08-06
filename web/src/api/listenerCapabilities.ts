import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from './client';

const listenerCapabilitiesSchema = z.object({ playlists: z.boolean() }).strict();

export const listenerCapabilitiesQueryKey = ['listener', 'capabilities'] as const;

/** Reads rollout state separately so the persistent shell does not import catalog schemas. */
export const getListenerCapabilities = (signal?: AbortSignal) => apiRequest(
  '/api/listener/v1/capabilities',
  listenerCapabilitiesSchema,
  { signal, retryAuthentication: false }
);

export const listenerCapabilitiesQuery = () => queryOptions({
  queryKey: listenerCapabilitiesQueryKey,
  queryFn: ({ signal }) => getListenerCapabilities(signal),
  retry: false,
  staleTime: 30_000
});
