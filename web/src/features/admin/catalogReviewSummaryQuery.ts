import { adminEndpointRequest } from './adminTransport';
import type { CatalogReview } from './catalogReviewApi';
import type { ReviewIdentityResponse, ReviewLookupResponse } from './catalogReviewLookupApi';
import { lookupPollMs } from './lookupNextStep';

type Access = { viewerId: string; epoch: number; generation: number };

/** The review detail's query key; must equal AdminCatalogReviewPage's detail query key, so the summary can ask it to read again. */
export const catalogReviewKey = (access: Access, id: string) => ['admin-catalog-reviews', access.viewerId, access.epoch, access.generation, id] as const;
/**
 * While a newer revision of the same review is read, the previous read stays shown (marked as a placeholder, so its controls
 * wait), keeping unsaved identity choices mounted; a read for another account, view generation or review never stands in.
 */
const sameReview = (key: readonly unknown[]) => <T>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
  previousQuery && key.every((part, index) => previousQuery.queryKey[index] === part) ? previous : undefined;

/**
 * The review summary read (GET /catalog-reviews/:id/lookup): the lookup view, the review's revision and value revision and the
 * summary state, read again for each revision and polled while a run is active (lookupPollMs). Its strict schema loads with the
 * read, so the review page's chunk never carries it. A lookup application changes only the value revision, which the summary
 * compares with the detail's.
 */
export function catalogReviewSummaryQuery(access: Access, item: Pick<CatalogReview, 'id' | 'revision'>, online: boolean) {
  const key = [...catalogReviewKey(access, item.id), 'lookup'] as const;
  return {
    queryKey: [...key, item.revision],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ReviewLookupResponse> => {
      const { reviewLookupResponseSchema } = await import('./catalogReviewLookupApi');
      return adminEndpointRequest(`/catalog-reviews/${item.id}/lookup`, reviewLookupResponseSchema, { signal });
    },
    retry: false, gcTime: 0, placeholderData: sameReview(key),
    refetchInterval: (query: { state: { data?: ReviewLookupResponse } }) => lookupPollMs(query.state.data?.lookup, online)
  };
}

/**
 * The review's identity read (GET /catalog-reviews/:id/candidates), keyed by revision and value revision, since a lookup
 * application changes only the latter.
 */
export function catalogReviewCandidatesQuery(access: Access, item: Pick<CatalogReview, 'id' | 'revision' | 'valueRevision'>) {
  const key = [...catalogReviewKey(access, item.id), 'candidates'] as const;
  return {
    queryKey: [...key, item.revision, item.valueRevision],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ReviewIdentityResponse> => {
      const { reviewIdentitySchema } = await import('./catalogReviewLookupApi');
      return adminEndpointRequest(`/catalog-reviews/${item.id}/candidates`, reviewIdentitySchema, { signal });
    },
    retry: false, gcTime: 0, placeholderData: sameReview(key)
  };
}
