import { z } from 'zod';
import legacyAlbum from '../../../contracts/listener/v1/fixtures/album-legacy.json';
import currentAlbum from '../../../contracts/listener/v1/fixtures/album-current.json';
import {
  audioTrackSummarySchema,
  libraryTargetSchema,
  listenerAlbumSchema,
  listenerHomeSchema,
  listenerSearchSchema
} from './contentSchemas';
import { loginInputSchema, browserSessionSchema } from './schemas';

// Frozen v1 compatibility reader: deliberately independent of the current schemas.
// This is the supported reader baseline introduced with the additive-field policy,
// not a claim that historical strict clients already accept newer payloads.
const id = z.string().min(1);
const baselineAlbumReader = z.object({
  album: z.object({
    contentType: z.literal('album'), id, title: z.string(), artworkUrl: z.string(),
    artistNames: z.array(z.string()),
    releaseDate: z.object({ year: z.number().optional(), month: z.number().optional(), day: z.number().optional() }).strip().nullable()
  }).strip(),
  tracks: z.array(z.object({
    contentType: z.literal('audioTrack'), id, title: z.string(), artworkUrl: z.string(),
    artistNames: z.array(z.string()), albumId: id.nullable(), albumTitle: z.string().nullable(),
    duration: z.string().nullable(), streamUrl: z.string().min(1)
  }).strip())
}).strip();

test('current reader accepts the legacy JSON contract and applies only documented defaults', () => {
  expect(listenerAlbumSchema.parse(legacyAlbum)).toEqual({
    ...legacyAlbum, tracks: legacyAlbum.tracks.map((track) => ({ ...track, mediaType: 'audio' }))
  });
  expect(listenerSearchSchema.parse({ query: '', artists: [], albums: [], audioTracks: [] }).organizations).toEqual([]);
});

test('frozen compatibility reader accepts current server fields without propagating them', () => {
  expect(baselineAlbumReader.parse(currentAlbum)).toEqual(legacyAlbum);
  expect(listenerAlbumSchema.parse(currentAlbum)).toEqual(currentAlbum);
});

test('public response additions are stripped recursively before they enter a query cache', () => {
  const response = {
    ...currentAlbum,
    futureEnvelopeField: true,
    album: {
      ...currentAlbum.album,
      futureMetadata: { value: true },
      releaseDate: { year: 2026, futureCalendar: 'gregorian' },
      credits: currentAlbum.album.credits.map((credit) => ({ ...credit, futureCredit: true }))
    },
    tracks: currentAlbum.tracks.map((track) => ({ ...track, futureTrackField: true }))
  };
  expect(listenerAlbumSchema.parse(response)).toEqual(currentAlbum);
  expect(listenerHomeSchema.parse({
    title: 'Home', futureEnvelopeField: true,
    sections: [{ id: 'section-1', title: '', presentation: 'grid', futureField: true, items: [response.album] }]
  }).sections[0].items).toEqual([currentAlbum.album]);
});

test.each([
  { mediaType: 'hologram' },
  { contentType: 'podcast' },
  { id: '' },
  { streamUrl: null },
  { title: 7 },
  { attributionStatus: 'inferred' },
  { credits: [{ ...currentAlbum.album.credits[0], role: 'invented' }] }
])('unknown enum variants and malformed known values still fail: %j', (patch) => {
  expect(audioTrackSummarySchema.safeParse({ ...currentAlbum.tracks[0], ...patch }).success).toBe(false);
});

test('missing required response fields fail instead of becoming empty success', () => {
  const { title: _title, ...incomplete } = currentAlbum.tracks[0];
  expect(audioTrackSummarySchema.safeParse(incomplete).success).toBe(false);
  expect(listenerAlbumSchema.safeParse({ album: currentAlbum.album }).success).toBe(false);
});

test('request and account-response validation remain strict', () => {
  expect(libraryTargetSchema.safeParse({ contentType: 'album', contentId: 'album-1', admin: true }).success).toBe(false);
  expect(loginInputSchema.safeParse({ identifier: 'listener', password: 'password', role: 'admin' }).success).toBe(false);
  expect(browserSessionSchema.safeParse({
    user: {
      id: 'listener', email: 'listener@example.com', role: 'user', displayName: '',
      avatarRevision: 0, avatar: null, emailVerified: true
    },
    accessToken: 'unexpected'
  }).success).toBe(false);
});
