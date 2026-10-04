import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { listenerCapabilitiesQueryKey } from '../api/listenerCapabilities';

export interface SocialRollout { enabled: boolean; rooms: boolean }

/**
 * Seeds the public rollout capabilities that gate social entry points without a network read.
 * Tests default to a social-and-rooms deployment and opt into disabled rollouts explicitly.
 */
export const seedListenerCapabilities = (client: QueryClient, social: SocialRollout = { enabled: true, rooms: true }) => {
  // The persistent shell observes these capabilities for the whole session, so tests never garbage-collect them.
  client.setQueryDefaults(listenerCapabilitiesQueryKey, { gcTime: Infinity });
  client.setQueryData(listenerCapabilitiesQueryKey, { playlists: false, social });
  return client;
};

/** Gives presentational components the shell's query context with seeded rollout capabilities. */
export const listenerCapabilitiesWrapper = (social?: SocialRollout) => {
  const client = seedListenerCapabilities(new QueryClient({ defaultOptions: { queries: { retry: false } } }), social);
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
