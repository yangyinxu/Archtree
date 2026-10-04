import { queryOptions } from '@tanstack/react-query';

import { ApiError, apiRequest } from './client';
import { captureAccountOperation, isAccountOperationCurrent } from './accountEpoch';
import {
  libraryPageSchema,
  libraryTargetSchema,
  listenerAlbumSchema,
  listenerArtistSchema,
  listenerHomeSchema,
  listenerOrganizationSchema,
  listenerSearchSchema,
  listenerTrackSchema,
  recentlyPlayedResultSchema,
  saveStatusSchema,
  saveStatusesSchema,
  type LibraryContentType,
  type LibrarySort,
  type LibraryTarget,
  type SaveStatus
} from './contentSchemas';

const listenerBasePath = '/api/listener/v1';
const anonymousViewerKey = 'anonymous';

export interface LibraryPageOptions {
  query?: string;
  contentTypes?: LibraryContentType[];
  sort?: LibrarySort;
  limit?: number;
  cursor?: string;
}

const normalizedViewerKey = (viewerKey?: string | null) => viewerKey?.trim() || anonymousViewerKey;
const normalizedSearchQuery = (query: string) => query.trim();
const encodedContentPath = (segment: string, contentId: string) =>
  `${listenerBasePath}/${segment}/${encodeURIComponent(contentId.trim())}`;

const normalizedLibraryOptions = (options: LibraryPageOptions = {}) => ({
  query: options.query?.trim().slice(0, 100) || '',
  contentTypes: [...new Set(options.contentTypes ?? [])].sort(),
  sort: options.sort ?? 'recentActivity',
  limit: Math.max(1, Math.min(100, Math.floor(options.limit ?? 50))),
  cursor: options.cursor?.trim() || undefined
});

export const listenerQueryKeys = {
  all: ['listener'] as const,
  home: (viewerKey?: string | null) => ['listener', 'home', normalizedViewerKey(viewerKey)] as const,
  search: (query: string) => ['listener', 'search', normalizedSearchQuery(query)] as const,
  album: (albumId: string) => ['listener', 'album', albumId.trim()] as const,
  artist: (artistId: string) => ['listener', 'artist', artistId.trim()] as const,
  organization: (organizationId: string) => ['listener', 'organization', organizationId.trim()] as const,
  track: (audioTrackId: string) => ['listener', 'audioTrack', audioTrackId.trim()] as const,
  library: (viewerKey: string, options: LibraryPageOptions = {}) =>
    ['listener', 'library', viewerKey, normalizedLibraryOptions(options)] as const,
  recentlyPlayed: (viewerKey: string) => ['listener', 'library', viewerKey, 'recently-played'] as const,
  saveStatuses: (viewerKey: string, items: LibraryTarget[]) => [
    'listener',
    'save-statuses',
    viewerKey,
    items.map((item) => `${item.contentType}:${item.contentId}`).sort()
  ] as const
};

export const getListenerHome = (viewerKey?: string | null, signal?: AbortSignal) => {
  const viewer = viewerKey?.trim();
  return apiRequest(`${listenerBasePath}/home`, listenerHomeSchema, {
    signal,
    ...(viewer ? { accountViewer: viewer } : {})
  });
};

export const getListenerSearch = (query: string, signal?: AbortSignal) => {
  const parameters = new URLSearchParams({ q: normalizedSearchQuery(query) });
  return apiRequest(`${listenerBasePath}/search?${parameters}`, listenerSearchSchema, { signal });
};

export const getListenerAlbum = (albumId: string, signal?: AbortSignal) =>
  apiRequest(encodedContentPath('albums', albumId), listenerAlbumSchema, { signal });

export const getListenerArtist = (artistId: string, signal?: AbortSignal) =>
  apiRequest(encodedContentPath('artists', artistId), listenerArtistSchema, { signal });

export const getListenerOrganization = (organizationId: string, signal?: AbortSignal) =>
  apiRequest(encodedContentPath('organizations', organizationId), listenerOrganizationSchema, { signal });

export const getListenerTrack = (audioTrackId: string, signal?: AbortSignal) =>
  apiRequest(encodedContentPath('tracks', audioTrackId), listenerTrackSchema, { signal });

export const listenerHomeQuery = (viewerKey?: string | null) => queryOptions({
  queryKey: listenerQueryKeys.home(viewerKey),
  queryFn: ({ signal }) => getListenerHome(viewerKey, signal)
});

export const listenerSearchQuery = (query: string) => {
  const normalized = normalizedSearchQuery(query);
  return queryOptions({
    queryKey: listenerQueryKeys.search(normalized),
    queryFn: ({ signal }) => getListenerSearch(normalized, signal),
    enabled: normalized.length > 0
  });
};

export const listenerAlbumQuery = (albumId: string) => queryOptions({
  queryKey: listenerQueryKeys.album(albumId),
  queryFn: ({ signal }) => getListenerAlbum(albumId, signal),
  enabled: albumId.trim().length > 0
});

export const listenerArtistQuery = (artistId: string) => queryOptions({
  queryKey: listenerQueryKeys.artist(artistId),
  queryFn: ({ signal }) => getListenerArtist(artistId, signal),
  enabled: artistId.trim().length > 0
});

export const listenerOrganizationQuery = (organizationId: string) => queryOptions({
  queryKey: listenerQueryKeys.organization(organizationId),
  queryFn: ({ signal }) => getListenerOrganization(organizationId, signal),
  enabled: organizationId.trim().length > 0
});

export const listenerTrackQuery = (audioTrackId: string) => queryOptions({
  queryKey: listenerQueryKeys.track(audioTrackId),
  queryFn: ({ signal }) => getListenerTrack(audioTrackId, signal),
  enabled: audioTrackId.trim().length > 0
});

export const getLibraryPage = (
  viewerKey: string,
  options: LibraryPageOptions = {},
  signal?: AbortSignal
) => {
  const normalized = normalizedLibraryOptions(options);
  const parameters = new URLSearchParams({
    sort: normalized.sort,
    limit: String(normalized.limit)
  });
  if (normalized.contentTypes.length > 0) parameters.set('types', normalized.contentTypes.join(','));
  if (normalized.cursor) parameters.set('cursor', normalized.cursor);
  if (normalized.query) parameters.set('q', normalized.query);
  return apiRequest(`${listenerBasePath}/library?${parameters}`, libraryPageSchema, {
    signal,
    accountViewer: viewerKey
  });
};

export const libraryPageQuery = (
  viewerKey: string,
  options: LibraryPageOptions = {}
) => queryOptions({
  queryKey: listenerQueryKeys.library(viewerKey, options),
  queryFn: ({ signal }) => getLibraryPage(viewerKey, options, signal),
  enabled: viewerKey.trim().length > 0
});

/** Resolves the whole collection in bounded batches without publishing partial or stale account data. */
export const getSaveStatuses = async (
  viewerKey: string,
  items: LibraryTarget[],
  signal?: AbortSignal
) => {
  const identity = (target: LibraryTarget) => `${target.contentType}:${target.contentId}`;
  const targets = [...new Map(libraryTargetSchema.array().parse(items)
    .map((target) => [identity(target), target])).values()];
  const guard = captureAccountOperation(viewerKey);
  const resolved: SaveStatus[] = [];
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (!isAccountOperationCurrent(guard)) {
      throw new ApiError('The active account changed.', 'invalid-response', 409, 'account_viewer_mismatch');
    }
  };
  for (let offset = 0; offset < targets.length; offset += 100) {
    assertCurrent();
    const batch = targets.slice(offset, offset + 100);
    const result = await apiRequest('/content/me/saves/status', saveStatusesSchema, {
      method: 'POST',
      body: JSON.stringify({ items: batch }),
      accountViewer: viewerKey,
      signal
    });
    assertCurrent();
    const expected = new Set(batch.map(identity));
    if (result.items.length !== batch.length || result.items.some((item) => !expected.delete(identity(item)))) {
      throw new ApiError('The server returned incomplete Save states.', 'invalid-response');
    }
    resolved.push(...result.items);
  }
  assertCurrent();
  return { items: resolved };
};

export const saveStatusesQuery = (viewerKey: string, items: LibraryTarget[]) => queryOptions({
  queryKey: listenerQueryKeys.saveStatuses(viewerKey, items),
  queryFn: ({ signal }) => getSaveStatuses(viewerKey, items, signal),
  enabled: viewerKey.trim().length > 0 && items.length > 0
});

const mutateSave = (
  viewerKey: string,
  target: LibraryTarget,
  method: 'PUT' | 'DELETE',
  signal?: AbortSignal
) => {
  const parsed = libraryTargetSchema.parse(target);
  const path = `/content/me/saves/${parsed.contentType}/${encodeURIComponent(parsed.contentId)}`;
  return apiRequest(path, saveStatusSchema, {
    method,
    body: '{}',
    accountViewer: viewerKey,
    signal
  });
};

export const saveContent = (viewerKey: string, target: LibraryTarget, signal?: AbortSignal) =>
  mutateSave(viewerKey, target, 'PUT', signal);

export const unsaveContent = (viewerKey: string, target: LibraryTarget, signal?: AbortSignal) =>
  mutateSave(viewerKey, target, 'DELETE', signal);

export const recordRecentlyPlayed = (
  target: LibraryTarget,
  viewerId: string,
  signal?: AbortSignal
) => {
  const parsed = libraryTargetSchema.parse(target);
  return apiRequest('/content/me/recently-played', recentlyPlayedResultSchema, {
    method: 'POST',
    body: JSON.stringify(parsed),
    accountViewer: viewerId,
    signal
  });
};
