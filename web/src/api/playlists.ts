import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest, apiRequestNoContent } from './client';
import { audioTrackSummarySchema } from './contentSchemas';

const playlistIdSchema = z.string().trim().min(1).max(200);
const itemIdSchema = z.string().trim().min(1).max(200);
const playlistRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const playlistTimestampSchema = z.string().datetime();
const playlistControlCharacters = /[\u0000-\u001F\u007F]/;
const validPlaylistName = (name: string) => Array.from(name).length >= 1
  && Array.from(name).length <= 100
  && !playlistControlCharacters.test(name);
const validPlaylistArtworkUrl = (artworkUrl: string) => {
  if (!artworkUrl) return true;
  if (artworkUrl.startsWith('/')) {
    return !artworkUrl.startsWith('//') && !artworkUrl.includes('\\');
  }
  try {
    const parsed = new URL(artworkUrl);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

/** Counts Unicode code points so one visible astral character is not charged twice. */
export const playlistNameSchema = z.string().transform((name) => name.normalize('NFC').trim()).refine(
  validPlaylistName,
  'Playlist names must contain between 1 and 100 characters.'
);
const playlistResponseNameSchema = z.string().refine(
  (name) => name === name.normalize('NFC').trim() && validPlaylistName(name),
  'Playlist response names must already be normalized.'
);

export const playlistSummarySchema = z.object({
  id: playlistIdSchema,
  name: playlistResponseNameSchema,
  itemCount: z.number().int().min(0).max(500),
  artworkUrl: z.string().trim().max(2_048).refine(
    validPlaylistArtworkUrl,
    'Playlist artwork URLs must use a same-origin path or HTTPS.'
  ),
  revision: playlistRevisionSchema,
  createdAt: playlistTimestampSchema,
  updatedAt: playlistTimestampSchema
}).strict();

export const playlistItemSchema = z.object({
  itemId: itemIdSchema,
  audioTrackId: playlistIdSchema,
  addedAt: playlistTimestampSchema,
  availability: z.enum(['ready', 'unavailable']),
  audioTrack: audioTrackSummarySchema.nullable()
}).strict().superRefine((item, context) => {
  if (item.availability === 'ready' && !item.audioTrack) {
    context.addIssue({ code: 'custom', message: 'A ready Playlist item requires a Soundtrack.' });
  }
  if (item.availability === 'unavailable' && item.audioTrack) {
    context.addIssue({ code: 'custom', message: 'An unavailable Playlist item cannot expose a Soundtrack.' });
  }
  if (item.audioTrack && item.audioTrack.id !== item.audioTrackId) {
    context.addIssue({ code: 'custom', message: 'Playlist item identity does not match its Soundtrack.' });
  }
});

export const playlistDetailSchema = playlistSummarySchema.extend({
  items: z.array(playlistItemSchema).max(500)
}).strict().superRefine((playlist, context) => {
  if (playlist.itemCount !== playlist.items.length) {
    context.addIssue({ code: 'custom', message: 'Playlist item count does not match its items.' });
  }
  const itemIds = new Set(playlist.items.map((item) => item.itemId));
  const soundtrackIds = new Set(playlist.items.map((item) => item.audioTrackId));
  if (itemIds.size !== playlist.items.length || soundtrackIds.size !== playlist.items.length) {
    context.addIssue({ code: 'custom', message: 'Playlist members must be unique.' });
  }
});

export const playlistPageSchema = z.object({
  items: z.array(playlistSummarySchema).max(100),
  nextCursor: z.string().min(1).nullable()
}).strict();

export const playlistMembershipSchema = z.object({
  audioTrackId: playlistIdSchema,
  playlistIds: z.array(playlistIdSchema).max(100).refine(
    (playlistIds) => new Set(playlistIds).size === playlistIds.length,
    'Playlist membership IDs must be unique.'
  )
}).strict();

export const playlistMembershipPageSchema = z.object({
  items: z.array(playlistMembershipSchema).min(1).max(50)
}).strict().superRefine((page, context) => {
  if (new Set(page.items.map((item) => item.audioTrackId)).size !== page.items.length) {
    context.addIssue({ code: 'custom', message: 'Soundtrack membership rows must be unique.' });
  }
});

const playlistPageOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).optional()
}).strict();

const createPlaylistInputSchema = z.object({ name: playlistNameSchema }).strict();
const renamePlaylistInputSchema = z.object({ name: playlistNameSchema }).strict();
const addPlaylistItemInputSchema = z.object({
  audioTrackId: playlistIdSchema,
  position: z.number().int().min(0).max(499).optional()
}).strict();
const reorderPlaylistItemsInputSchema = z.object({
  itemIds: z.array(itemIdSchema).max(500).refine(
    (itemIds) => new Set(itemIds).size === itemIds.length,
    'Playlist order cannot contain repeated item IDs.'
  )
}).strict();

export type PlaylistSummary = z.infer<typeof playlistSummarySchema>;
export type PlaylistItem = z.infer<typeof playlistItemSchema>;
export type PlaylistDetail = z.infer<typeof playlistDetailSchema>;
export type PlaylistPage = z.infer<typeof playlistPageSchema>;
export type PlaylistMembershipPage = z.infer<typeof playlistMembershipPageSchema>;

export interface PlaylistPageOptions {
  limit?: number;
  cursor?: string;
}

interface PlaylistMutationIdentity {
  viewerId: string;
  idempotencyKey: string;
}

interface ExistingPlaylistMutation extends PlaylistMutationIdentity {
  playlistId: string;
  revision: number;
}

interface CreatePlaylistMutation extends PlaylistMutationIdentity {
  name: string;
}

interface RenamePlaylistMutation extends ExistingPlaylistMutation {
  name: string;
}

interface AddPlaylistItemMutation extends ExistingPlaylistMutation {
  audioTrackId: string;
  position?: number;
}

interface RemovePlaylistItemMutation extends ExistingPlaylistMutation {
  itemId: string;
}

interface ReorderPlaylistItemsMutation extends ExistingPlaylistMutation {
  itemIds: string[];
}

const normalizedViewerId = (viewerId: string) => playlistIdSchema.parse(viewerId);
const cacheViewerKey = (viewerId: string) => viewerId.trim() || 'signed-out';
const normalizedPageOptions = (options: PlaylistPageOptions = {}) => playlistPageOptionsSchema.parse({
  limit: options.limit ?? 50,
  cursor: options.cursor?.trim() || undefined
});

const encodedPlaylistPath = (playlistId: string) =>
  `/content/me/playlists/${encodeURIComponent(playlistIdSchema.parse(playlistId))}`;

const mutationHeaders = (
  identity: PlaylistMutationIdentity,
  revision?: number
) => {
  const viewerId = normalizedViewerId(identity.viewerId);
  const idempotencyKey = z.string().trim().min(1).max(128).parse(identity.idempotencyKey);
  const headers: Record<string, string> = {
    'Idempotency-Key': idempotencyKey,
    'X-Finitude-Account-Viewer': viewerId
  };
  if (revision !== undefined) {
    headers['If-Match'] = `"${playlistRevisionSchema.parse(revision)}"`;
  }
  return headers;
};

/** Generates an opaque key once per user mutation so a lost response can be replayed safely. */
export const createPlaylistIdempotencyKey = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('This browser cannot create a secure Playlist request key.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const playlistQueryKeys = {
  all: ['listener', 'playlists'] as const,
  lists: (viewerId: string) => ['listener', 'playlists', cacheViewerKey(viewerId)] as const,
  list: (viewerId: string, options: PlaylistPageOptions = {}) => [
    'listener',
    'playlists',
    cacheViewerKey(viewerId),
    normalizedPageOptions(options)
  ] as const,
  detail: (viewerId: string, playlistId: string) => [
    'listener',
    'playlist',
    cacheViewerKey(viewerId),
    playlistId.trim() || 'missing-playlist'
  ] as const,
  memberships: (viewerId: string, audioTrackIds: string[]) => [
    'listener',
    'playlist-memberships',
    cacheViewerKey(viewerId),
    [...new Set(audioTrackIds.map((id) => playlistIdSchema.parse(id)))].sort()
  ] as const
};

export const getPlaylistPage = (
  viewerId: string,
  options: PlaylistPageOptions = {},
  signal?: AbortSignal
) => {
  const normalized = normalizedPageOptions(options);
  const parameters = new URLSearchParams({ limit: String(normalized.limit) });
  if (normalized.cursor) parameters.set('cursor', normalized.cursor);
  return apiRequest(`/content/me/playlists?${parameters}`, playlistPageSchema, {
    signal,
    accountViewer: viewerId
  });
};

export const playlistPageQuery = (viewerId: string, options: PlaylistPageOptions = {}) =>
  queryOptions({
    queryKey: playlistQueryKeys.list(viewerId, options),
    queryFn: ({ signal }) => getPlaylistPage(viewerId, options, signal),
    enabled: viewerId.trim().length > 0
  });

export const getPlaylist = (viewerId: string, playlistId: string, signal?: AbortSignal) =>
  apiRequest(encodedPlaylistPath(playlistId), playlistDetailSchema, {
    signal,
    accountViewer: viewerId
  });

export const playlistDetailQuery = (viewerId: string, playlistId: string) =>
  queryOptions({
    queryKey: playlistQueryKeys.detail(viewerId, playlistId),
    queryFn: ({ signal }) => getPlaylist(viewerId, playlistId, signal),
    enabled: viewerId.trim().length > 0 && playlistId.trim().length > 0
  });

export const getPlaylistMemberships = (
  viewerId: string,
  audioTrackIds: string[],
  signal?: AbortSignal
) => {
  const ids = [...new Set(audioTrackIds.map((audioTrackId) => playlistIdSchema.parse(audioTrackId)))]
    .sort();
  if (ids.length < 1 || ids.length > 50) {
    throw new Error('Playlist membership lookup requires between 1 and 50 Soundtrack IDs.');
  }
  const parameters = new URLSearchParams({ audioTrackIds: ids.join(',') });
  return apiRequest(
    `/content/me/playlists/memberships?${parameters}`,
    playlistMembershipPageSchema,
    { signal, accountViewer: viewerId }
  );
};

export const playlistMembershipsQuery = (viewerId: string, audioTrackIds: string[]) => {
  const ids = [...new Set(audioTrackIds.map((audioTrackId) => playlistIdSchema.parse(audioTrackId)))]
    .sort();
  return queryOptions({
    queryKey: playlistQueryKeys.memberships(viewerId, ids),
    queryFn: ({ signal }) => getPlaylistMemberships(viewerId, ids, signal),
    enabled: viewerId.trim().length > 0 && ids.length > 0
  });
};

export const createPlaylist = (input: CreatePlaylistMutation) => {
  const body = createPlaylistInputSchema.parse({ name: input.name });
  return apiRequest('/content/me/playlists', playlistDetailSchema, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: mutationHeaders(input),
    accountViewer: input.viewerId
  });
};

export const renamePlaylist = (input: RenamePlaylistMutation) => {
  const body = renamePlaylistInputSchema.parse({ name: input.name });
  return apiRequest(encodedPlaylistPath(input.playlistId), playlistDetailSchema, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: mutationHeaders(input, input.revision),
    accountViewer: input.viewerId
  });
};

export const deletePlaylist = (input: ExistingPlaylistMutation) =>
  apiRequestNoContent(encodedPlaylistPath(input.playlistId), {
    method: 'DELETE',
    body: '{}',
    headers: mutationHeaders(input, input.revision),
    accountViewer: input.viewerId
  });

export const addPlaylistItem = (input: AddPlaylistItemMutation) => {
  const body = addPlaylistItemInputSchema.parse({
    audioTrackId: input.audioTrackId,
    position: input.position
  });
  return apiRequest(`${encodedPlaylistPath(input.playlistId)}/items`, playlistDetailSchema, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: mutationHeaders(input, input.revision),
    accountViewer: input.viewerId
  });
};

export const removePlaylistItem = (input: RemovePlaylistItemMutation) =>
  apiRequest(
    `${encodedPlaylistPath(input.playlistId)}/items/${encodeURIComponent(itemIdSchema.parse(input.itemId))}`,
    playlistDetailSchema,
    {
      method: 'DELETE',
      body: '{}',
      headers: mutationHeaders(input, input.revision),
      accountViewer: input.viewerId
    }
  );

export const reorderPlaylistItems = (input: ReorderPlaylistItemsMutation) => {
  const body = reorderPlaylistItemsInputSchema.parse({ itemIds: input.itemIds });
  return apiRequest(`${encodedPlaylistPath(input.playlistId)}/items/order`, playlistDetailSchema, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: mutationHeaders(input, input.revision),
    accountViewer: input.viewerId
  });
};
