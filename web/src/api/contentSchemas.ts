import { z } from 'zod';

const contentIdSchema = z.string().trim().min(1);
const artworkUrlSchema = z.string().trim();
const artistNamesSchema = z.array(z.string().trim().min(1));

export const listenerDateSchema = z
  .object({
    year: z.number().int().min(1).max(9999).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional()
  })
  .strict();

export const artistSummarySchema = z
  .object({
    contentType: z.literal('artist'),
    id: contentIdSchema,
    name: z.string(),
    bio: z.string(),
    artworkUrl: artworkUrlSchema
  })
  .strict();

export const albumSummarySchema = z
  .object({
    contentType: z.literal('album'),
    id: contentIdSchema,
    title: z.string(),
    artworkUrl: artworkUrlSchema,
    artistNames: artistNamesSchema,
    releaseDate: listenerDateSchema.nullable()
  })
  .strict();

export const audioTrackSummarySchema = z
  .object({
    contentType: z.literal('audioTrack'),
    id: contentIdSchema,
    title: z.string(),
    artworkUrl: artworkUrlSchema,
    artistNames: artistNamesSchema,
    albumId: contentIdSchema.nullable(),
    albumTitle: z.string().nullable(),
    duration: z.string().nullable(),
    streamUrl: z.string().trim().min(1)
  })
  .strict();

export const contentSummarySchema = z.discriminatedUnion('contentType', [
  artistSummarySchema,
  albumSummarySchema,
  audioTrackSummarySchema
]);

export const sectionPresentationSchema = z.enum(['carousel', 'grid', 'list']);
export const homeSectionSchema = z
  .object({
    id: contentIdSchema,
    title: z.string(),
    presentation: sectionPresentationSchema,
    items: z.array(z.discriminatedUnion('contentType', [albumSummarySchema, audioTrackSummarySchema]))
  })
  .strict();

export const listenerHomeSchema = z
  .object({
    title: z.string(),
    sections: z.array(homeSectionSchema)
  })
  .strict();

export const listenerSearchSchema = z
  .object({
    query: z.string(),
    artists: z.array(artistSummarySchema),
    albums: z.array(albumSummarySchema),
    audioTracks: z.array(audioTrackSummarySchema)
  })
  .strict();

export const listenerAlbumSchema = z
  .object({
    album: albumSummarySchema,
    tracks: z.array(audioTrackSummarySchema)
  })
  .strict();

export const listenerArtistSchema = z
  .object({
    artist: artistSummarySchema,
    albums: z.array(albumSummarySchema),
    audioTracks: z.array(audioTrackSummarySchema)
  })
  .strict();

export const listenerTrackSchema = z
  .object({
    audioTrack: audioTrackSummarySchema
  })
  .strict();

export const libraryContentTypeSchema = z.enum(['album', 'audioTrack']);
export const librarySortSchema = z.enum(['recentActivity', 'recentlySaved', 'recentlyPlayed']);

const libraryDateSchema = z.string().trim().min(1);
const libraryAlbumPayloadSchema = z
  .object({
    _id: contentIdSchema,
    title: z.string().optional().default(''),
    coverArtUrl: artworkUrlSchema.optional().default(''),
    releaseDate: listenerDateSchema.nullish().transform((value) => value ?? null)
  })
  .strip();

const libraryAudioTrackPayloadSchema = z
  .object({
    _id: contentIdSchema,
    title: z.string().optional().default(''),
    displayCoverArtUrl: artworkUrlSchema.optional().default(''),
    coverArtUrl: artworkUrlSchema.optional().default(''),
    albumId: contentIdSchema.nullish().transform((value) => value ?? null),
    duration: z.string().nullish().transform((value) => value ?? null),
    available: z.boolean(),
    streamUrl: z.string().trim().min(1).nullable()
  })
  .strip();

const libraryActivityFields = {
  contentId: contentIdSchema,
  savedAt: libraryDateSchema,
  lastPlayedAt: libraryDateSchema.nullable(),
  lastActivityAt: libraryDateSchema,
  creator: z.string().nullable()
};

export const libraryAlbumItemSchema = z
  .object({
    contentType: z.literal('album'),
    ...libraryActivityFields,
    album: libraryAlbumPayloadSchema
  })
  .strip();

export const libraryAudioTrackItemSchema = z
  .object({
    contentType: z.literal('audioTrack'),
    ...libraryActivityFields,
    audioTrack: libraryAudioTrackPayloadSchema
  })
  .strip();

export const libraryItemSchema = z.discriminatedUnion('contentType', [
  libraryAlbumItemSchema,
  libraryAudioTrackItemSchema
]);

export const libraryPageSchema = z
  .object({
    items: z.array(libraryItemSchema),
    nextCursor: z.string().min(1).nullable()
  })
  .strip();

export const libraryTargetSchema = z
  .object({
    contentType: libraryContentTypeSchema,
    contentId: contentIdSchema
  })
  .strict();

export const saveStatusSchema = libraryTargetSchema
  .extend({ saved: z.boolean() })
  .strict();

export const saveStatusesSchema = z
  .object({ items: z.array(saveStatusSchema) })
  .strict();

export const recentlyPlayedResultSchema = libraryTargetSchema
  .extend({ recorded: z.literal(true) })
  .strict();

export type ArtistSummary = z.infer<typeof artistSummarySchema>;
export type AlbumSummary = z.infer<typeof albumSummarySchema>;
export type AudioTrackSummary = z.infer<typeof audioTrackSummarySchema>;
export type ContentSummary = z.infer<typeof contentSummarySchema>;
export type SectionPresentation = z.infer<typeof sectionPresentationSchema>;
export type HomeSection = z.infer<typeof homeSectionSchema>;
export type ListenerHome = z.infer<typeof listenerHomeSchema>;
export type ListenerSearch = z.infer<typeof listenerSearchSchema>;
export type ListenerAlbum = z.infer<typeof listenerAlbumSchema>;
export type ListenerArtist = z.infer<typeof listenerArtistSchema>;
export type ListenerTrack = z.infer<typeof listenerTrackSchema>;
export type LibraryContentType = z.infer<typeof libraryContentTypeSchema>;
export type LibrarySort = z.infer<typeof librarySortSchema>;
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type LibraryPage = z.infer<typeof libraryPageSchema>;
export type LibraryTarget = z.infer<typeof libraryTargetSchema>;
export type SaveStatus = z.infer<typeof saveStatusSchema>;
