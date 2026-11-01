import { z } from 'zod';

import { apiRequest } from './client';
import { audioTrackSummarySchema } from './contentSchemas';

/** One newest-first page of public Video MediaTracks; nextCursor is opaque. */
export const listenerVideosSchema = z
  .object({
    items: z.array(audioTrackSummarySchema.refine((track) => track.mediaType === 'video')).max(48),
    nextCursor: z.string().min(1).max(2_048).nullable()
  })
  .strip()
  .refine((page) => new Set(page.items.map((track) => track.id)).size === page.items.length)
  .refine((page) => page.nextCursor === null || page.items.length > 0);

export type ListenerVideos = z.infer<typeof listenerVideosSchema>;

export const listenerVideosQueryKey = ['listener', 'videos'] as const;

/** Reads one Videos page; omitting the cursor starts from the newest Video. */
export const getListenerVideos = (cursor?: string, signal?: AbortSignal) => {
  const parameters = new URLSearchParams({ limit: '24' });
  if (cursor) parameters.set('cursor', cursor);
  return apiRequest(`/api/listener/v1/videos?${parameters}`, listenerVideosSchema, { signal });
};
