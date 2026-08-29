import { ApiError, apiRequest } from './client';
import {
  listenerCollectionPageSchema,
  maximumListenerCollectionCursorLength,
  type ListenerCollectionPage,
  type ListenerPageSlug
} from './collectionSchemas';

const listenerBasePath = '/api/listener/v1';
const anonymousViewerKey = 'anonymous';

export interface ListenerCollectionPageOptions {
  limit?: number;
  cursor?: string;
  continuation?: ListenerCollectionContinuation;
}

export interface ListenerCollectionContinuation {
  pageItem: ListenerCollectionPage['pageItem'];
  afterOrder?: number;
  usedCursors: readonly string[];
}

const invalidContinuation = (code = 'collection_cursor_mismatch') => new ApiError(
  'Grid/List traversal is invalid.',
  'invalid-response',
  200,
  code
);

const samePageItem = (
  left: ListenerCollectionPage['pageItem'],
  right: ListenerCollectionPage['pageItem']
) => left.id === right.id
  && left.pageSlug === right.pageSlug
  && left.title === right.title
  && left.presentation === right.presentation
  && left.mode === right.mode
  && left.contentType === right.contentType;

/** Rejects a response that cannot continue the already-rendered traversal safely. */
const assertCollectionContinuation = (
  page: ListenerCollectionPage,
  continuation?: ListenerCollectionContinuation
) => {
  if (page.items.length > page.limit || (page.nextCursor !== null && page.items.length === 0)) {
    throw invalidContinuation('invalid_collection_cursor');
  }
  if (!continuation) return;
  if (!samePageItem(page.pageItem, continuation.pageItem)) {
    throw invalidContinuation();
  }
  const afterOrder = continuation.afterOrder;
  if (afterOrder !== undefined && page.items.some((item) => item.order <= afterOrder)) {
    throw invalidContinuation();
  }
  if (page.nextCursor && continuation.usedCursors.includes(page.nextCursor)) {
    throw invalidContinuation('invalid_collection_cursor');
  }
};

const normalizedCollectionPageOptions = (options: ListenerCollectionPageOptions = {}) => {
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit!) : 20;
  const cursor = options.cursor?.trim() || undefined;
  if (cursor && cursor.length > maximumListenerCollectionCursorLength) {
    throw invalidContinuation('invalid_collection_cursor');
  }
  return {
    limit: Math.max(1, Math.min(100, requestedLimit)),
    cursor
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
  let result: ListenerCollectionPage;
  try {
    result = await apiRequest(
      `${listenerBasePath}/pages/${pageSlug}/items/${encodeURIComponent(normalizedItemId)}?${parameters}`,
      listenerCollectionPageSchema,
      {
        signal,
        ...(normalizedViewer ? { accountViewer: normalizedViewer } : {})
      }
    );
  } catch (error) {
    if (normalized.cursor && error instanceof ApiError
      && error.kind === 'invalid-response' && !error.code) {
      throw invalidContinuation('invalid_collection_cursor');
    }
    throw error;
  }
  if (result.pageItem.id !== normalizedItemId || result.pageItem.pageSlug !== pageSlug) {
    throw invalidContinuation();
  }
  assertCollectionContinuation(result, options.continuation);
  return result;
};
