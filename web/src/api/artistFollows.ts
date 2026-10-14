import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from './client';
import { personalizationCapabilitiesQueryKey } from './personalizationQueryKeys';
export { personalizationCapabilitiesQueryKey } from './personalizationQueryKeys';

const artistIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const timestampSchema = z.iso.datetime({ precision: 3 });
export const artistFollowStatusSchema = z.object({
  artistId: artistIdSchema,
  following: z.boolean(),
  followedAt: timestampSchema.nullable()
}).strict().refine((value) => value.following === (value.followedAt !== null), 'Inconsistent follow state');
export const artistFollowStatusesSchema = z.object({ items: z.array(artistFollowStatusSchema).max(100) }).strict();
export type ArtistFollowStatus = z.infer<typeof artistFollowStatusSchema>;

export const personalizationCapabilitiesSchema = z.object({
  contractVersion: z.literal(1),
  deterministicDiscovery: z.literal(false),
  artistFollows: z.boolean()
}).strict();
/** A separate capability contract leaves released strict clients' original endpoint intact. */
export const personalizationCapabilitiesQuery = () => queryOptions({
  queryKey: personalizationCapabilitiesQueryKey,
  queryFn: ({ signal }) => apiRequest('/api/listener/v1/personalization-capabilities', personalizationCapabilitiesSchema,
    { signal, retryAuthentication: false }),
  retry: false,
  staleTime: 30_000
});
export const artistFollowQueryKey = (viewerId: string, artistId: string) =>
  ['listener', 'artist-follow', viewerId, artistId] as const;

/** Requires an exact ordered receipt so a partial or substituted response cannot become confirmed state. */
export const getArtistFollowStatuses = async (viewerId: string, artistIds: string[], signal?: AbortSignal) => {
  const ids = z.array(artistIdSchema).max(100).parse(artistIds);
  const result = await apiRequest('/content/me/artist-follows/status', artistFollowStatusesSchema, {
    method: 'POST', body: JSON.stringify({ artistIds: ids }), accountViewer: viewerId, signal
  });
  if (result.items.length !== ids.length || result.items.some((item, index) => item.artistId !== ids[index])) {
    throw new ApiError('Invalid follow status receipt.', 'invalid-response');
  }
  return result;
};
export const artistFollowQuery = (viewerId: string, artistId: string) => queryOptions({
  queryKey: artistFollowQueryKey(viewerId, artistId),
  queryFn: async ({ signal }) => (await getArtistFollowStatuses(viewerId, [artistId], signal)).items[0],
  retry: false
});

/** PUT/DELETE are naturally idempotent; only a matching server receipt confirms the requested action. */
export const setArtistFollowing = async (viewerId: string, artistId: string, following: boolean, signal?: AbortSignal) => {
  const id = artistIdSchema.parse(artistId);
  const result = await apiRequest(`/content/me/artist-follows/${encodeURIComponent(id)}`, artistFollowStatusSchema, {
    method: following ? 'PUT' : 'DELETE', body: '{}', accountViewer: viewerId, signal
  });
  if (result.artistId !== id || result.following !== following) {
    throw new ApiError('Invalid follow mutation receipt.', 'invalid-response');
  }
  return result;
};
