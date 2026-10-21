import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/);
/** Mirrors the server bound, which is also the listener Album read bound. */
export const catalogAlbumTracksLimit = 500;
const position = z.number().int().min(1).max(catalogAlbumTracksLimit);
const presentTrack = z.object({
  position, id, title: z.string().max(300), discNumber: z.number().int().min(1).max(999).nullable(),
  trackNumber: z.number().int().min(1).max(9999).nullable(), duration: z.string().regex(/^\d{1,3}(:[0-5]\d){1,2}$/).nullable(),
  mediaType: z.enum(['audio', 'video']), visibility: z.enum(['public', 'hidden']),
  state: z.enum(['ready', 'pending', 'failed', 'deleting', 'unpublished', 'unavailable']), linkedElsewhere: z.boolean()
}).strict();
const missingTrack = z.object({ position, id, state: z.literal('missing') }).strict();
/** The private read-only member list of one Album, numbered by its place in the Album order. */
export const catalogAlbumTracksSchema = z.object({
  albumId: id, order: z.enum(['declared', 'legacyAlbumLinks']), truncated: z.boolean(),
  skipped: z.number().int().min(0).max(catalogAlbumTracksLimit),
  tracks: z.array(z.union([presentTrack, missingTrack])).max(catalogAlbumTracksLimit)
}).strict().refine(value => value.tracks.every((track, index) => track.position === index + 1)
  && new Set(value.tracks.map(track => track.id)).size === value.tracks.length, 'Positions follow the list of distinct members');
export type CatalogAlbumTracks = z.infer<typeof catalogAlbumTracksSchema>;
export type CatalogAlbumTrack = CatalogAlbumTracks['tracks'][number];
