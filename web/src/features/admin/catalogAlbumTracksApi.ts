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
/** One expected row and the listed members at its Disc and Track Number; an empty `memberIds` is a row without a file. */
const expectedRow = z.object({
  discNumber: z.number().int().min(1).max(999), trackNumber: z.number().int().min(1).max(9999), title: z.string().min(1).max(300),
  durationMs: z.number().int().positive().nullable(), memberIds: z.array(id).max(catalogAlbumTracksLimit)
}).strict();
/** The stored tracklist as the server matched it to the listed members; it never carries a release, recording or file identity. */
const expectedTracklist = z.object({
  source: z.enum(['musicbrainz', 'itunes']), appliedAt: z.iso.datetime({ precision: 3 }),
  rows: z.array(expectedRow).min(1).max(100), outsideMemberIds: z.array(id).max(catalogAlbumTracksLimit)
}).strict().refine(value => value.rows.every((row, index) => index === 0 || value.rows[index - 1].discNumber < row.discNumber
  || (value.rows[index - 1].discNumber === row.discNumber && value.rows[index - 1].trackNumber < row.trackNumber)),
'Rows follow Disc then Track Number at distinct positions');
/** Every member with a record is placed exactly once, on a row or outside; an ID without a record is placed nowhere. */
const placesEachMember = (value: { tracks: Array<{ id: string; state: string }>; expected: z.infer<typeof expectedTracklist> | null }) => {
  if (!value.expected) return true;
  const placed = [...value.expected.rows.flatMap(row => row.memberIds), ...value.expected.outsideMemberIds], distinct = new Set(placed);
  const present = value.tracks.filter(track => track.state !== 'missing').map(track => track.id);
  return placed.length === present.length && distinct.size === placed.length && present.every(trackId => distinct.has(trackId));
};
/** The private read-only member list of one Album, numbered by its place in the Album order. */
export const catalogAlbumTracksSchema = z.object({
  albumId: id, order: z.enum(['declared', 'legacyAlbumLinks']), truncated: z.boolean(),
  skipped: z.number().int().min(0).max(catalogAlbumTracksLimit),
  tracks: z.array(z.union([presentTrack, missingTrack])).max(catalogAlbumTracksLimit),
  // A server without expected tracklists sends no key, which reads as none.
  expected: expectedTracklist.nullable().default(null)
}).strict().refine(value => value.tracks.every((track, index) => track.position === index + 1)
  && new Set(value.tracks.map(track => track.id)).size === value.tracks.length, 'Positions follow the list of distinct members')
  .refine(placesEachMember, 'Expected rows place each listed member once');
export type CatalogAlbumTracks = z.infer<typeof catalogAlbumTracksSchema>;
export type CatalogAlbumTrack = CatalogAlbumTracks['tracks'][number];
export type CatalogAlbumExpected = NonNullable<CatalogAlbumTracks['expected']>;
export type CatalogAlbumExpectedRow = CatalogAlbumExpected['rows'][number];
export { expectedSummary, expectedSummaryVariables, type CatalogAlbumExpectedSummary } from './catalogAlbumExpectedSummary';
