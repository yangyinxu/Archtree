import { z } from 'zod';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from './client';
import { albumSummarySchema, audioTrackSummarySchema } from './contentSchemas';
import { listenerQueryKeys } from './listener';

/** Recent playback is a bounded history, not another saved Library page. */
export const recentlyPlayedPageSchema = z.object({
  items: z.array(z.object({
    content: z.discriminatedUnion('contentType', [albumSummarySchema, audioTrackSummarySchema]),
    playedAt: z.string().datetime(),
    saved: z.boolean()
  }).strict()).max(20),
  limit: z.literal(20)
}).strict();

/** Keeps history in the account-owned Library cache for Save and clear-history invalidation. */
export const recentlyPlayedQuery = (viewerKey: string) => queryOptions({
  queryKey: listenerQueryKeys.recentlyPlayed(viewerKey),
  queryFn: ({ signal }) => apiRequest('/api/listener/v1/recently-played', recentlyPlayedPageSchema, {
    accountViewer: viewerKey, signal
  }),
  enabled: Boolean(viewerKey)
});
