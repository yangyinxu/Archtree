import { ApiError, apiRequest } from './client';
import {
  listenerCollectionPageSchema,
  type ListenerPageSlug
} from './collectionSchemas';

const listenerBasePath = '/api/listener/v1';
const anonymousViewerKey = 'anonymous';

export interface ListenerCollectionPageOptions {
  limit?: number;
  cursor?: string;
}

const normalizedCollectionPageOptions = (options: ListenerCollectionPageOptions = {}) => {
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit!) : 20;
  return {
    limit: Math.max(1, Math.min(100, requestedLimit)),
    cursor: options.cursor?.trim() || undefined
  };
};

export const listenerCollectionQueryKey = (
  pageSlug: ListenerPageSlug,
  pageItemId: string,
  viewerKey?: string | null
) => [
  'listener',
  'collection',
  pageSlug,
  pageItemId.trim(),
  viewerKey?.trim() || anonymousViewerKey
] as const;

/** Reads one attached manual Grid/List while preserving its parent viewer boundary. */
export const getListenerCollectionPage = async (
  pageSlug: ListenerPageSlug,
  pageItemId: string,
  viewerKey?: string | null,
  options: ListenerCollectionPageOptions = {},
  signal?: AbortSignal
) => {
  const normalizedItemId = pageItemId.trim();
  const normalizedViewer = viewerKey?.trim();
  const normalized = normalizedCollectionPageOptions(options);
  const parameters = new URLSearchParams({ limit: String(normalized.limit) });
  if (normalized.cursor) parameters.set('cursor', normalized.cursor);
  const result = await apiRequest(
    `${listenerBasePath}/pages/${pageSlug}/items/${encodeURIComponent(normalizedItemId)}?${parameters}`,
    listenerCollectionPageSchema,
    {
      signal,
      ...(normalizedViewer ? { accountViewer: normalizedViewer } : {})
    }
  );
  if (result.pageItem.id !== normalizedItemId || result.pageItem.pageSlug !== pageSlug) {
    throw new ApiError(
      'The server returned a collection for a different page item.',
      'invalid-response',
      200
    );
  }
  return result;
};
