import { queryOptions } from '@tanstack/react-query';

import { apiRequest } from './client';
import {
  libraryPageSchema,
  libraryTargetSchema,
  listenerAlbumSchema,
  listenerArtistSchema,
  listenerHomeSchema,
  listenerSearchSchema,
  listenerTrackSchema,
  recentlyPlayedResultSchema,
  saveStatusSchema,
  saveStatusesSchema,
  type LibraryContentType,
  type LibrarySort,
  type LibraryTarget
} from './contentSchemas';

const listenerBasePath = '/api/listener/v1';
const anonymousViewerKey = 'anonymous';

export interface LibraryPageOptions {
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
  track: (audioTrackId: string) => ['listener', 'audioTrack', audioTrackId.trim()] as const,
  library: (viewerKey: string, options: LibraryPageOptions = {}) =>
    ['listener', 'library', viewerKey, normalizedLibraryOptions(options)] as const,
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

export const getSaveStatuses = (
  viewerKey: string,
  items: LibraryTarget[],
  signal?: AbortSignal
) => {
  const targets = libraryTargetSchema.array().max(100).parse(items);
  return apiRequest('/content/me/saves/status', saveStatusesSchema, {
    method: 'POST',
    body: JSON.stringify({ items: targets }),
    accountViewer: viewerKey,
    signal
  });
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
