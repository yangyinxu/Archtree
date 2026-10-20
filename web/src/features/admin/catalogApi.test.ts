import { catalogItemSchema, catalogPatch } from './catalogApi';
import { detailSchema } from './adminApi';
import { suggestionSchema } from './reviewNamingSchema';
import { detail, slotId } from './adminFixtures.testSupport';
export const catalogAlbum = () => ({ kind: 'album' as const, id: '111111111111111111111111', revision: `cr_${'a'.repeat(43)}`, visibility: 'public' as const, effectiveVisibility: 'public' as const, coverUrl: null, mediaUrl: null, capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' as const } });
test('catalog edits preserve unrelated fields and Credits plus attribution are an atomic group', () => {
  const item = catalogAlbum();
  expect(catalogPatch(item, { ...item.fields, title: 'Changed title' }, 'public')).toEqual({ expectedRevision: item.revision, fields: { title: 'Changed title' } });
  expect(catalogPatch(item, { ...item.fields, credits: [], attributionStatus: 'documented' }, 'hidden')).toEqual({ expectedRevision: item.revision, fields: { credits: [], attributionStatus: 'documented' }, visibility: 'hidden' });
  expect(catalogPatch(item, item.fields, 'hidden')).not.toHaveProperty('fields');
});
test('protected projections reject external previews and invalid calendar precision', () => {
  const item = catalogAlbum();
  expect(catalogItemSchema.safeParse(item).success).toBe(true);
  expect(catalogItemSchema.safeParse({ ...item, coverUrl: 'https://foreign.invalid/private' }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, releaseDate: { year: 2025, month: 2, day: 29 } } }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, releaseDate: { year: 2024, month: null, day: 1 } } }).success).toBe(false);
});
test('MediaTrack snapshots always carry a bounded nullable Disc Number', () => {
  const base = catalogAlbum();
  const track = { ...base, kind: 'audioTrack' as const, mediaUrl: null, fields: { ...base.fields, discNumber: null as number | null, trackNumber: 1 } };
  for (const discNumber of [1, 999, null]) expect(catalogItemSchema.safeParse({ ...track, fields: { ...track.fields, discNumber } }).success).toBe(true);
  for (const discNumber of [0, 1000, 1.5, '2']) expect(catalogItemSchema.safeParse({ ...track, fields: { ...track.fields, discNumber } }).success).toBe(false);
  const { discNumber: _discNumber, ...withoutDisc } = track.fields;
  expect(catalogItemSchema.safeParse({ ...track, fields: withoutDisc }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...base, fields: { ...base.fields, discNumber: 1 } }).success).toBe(false);
});
test('a Credit may carry a short join phrase, and a phrase-only edit changes the Credits group', () => {
  const credit = { creditId: 'credit-one', subjectType: 'artist' as const, subjectId: '222222222222222222222222', role: 'primary' as const, order: 0 };
  const item = { ...catalogAlbum(), fields: { ...catalogAlbum().fields, credits: [credit], attributionStatus: 'documented' as const } };
  for (const joinPhrase of [' & ', '、', 'a'.repeat(16)]) expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, credits: [{ ...credit, joinPhrase }] } }).success).toBe(true);
  for (const joinPhrase of ['', 'a'.repeat(17), null]) expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, credits: [{ ...credit, joinPhrase }] } }).success).toBe(false);
  expect(catalogPatch(item, { ...item.fields, credits: [{ ...credit, joinPhrase: ' feat. ' }] }, 'public')).toEqual({ expectedRevision: item.revision, fields: { credits: [{ ...credit, joinPhrase: ' feat. ' }], attributionStatus: 'documented' } });
});
test('suggestions and embedded covers cannot address another file or mix field types', () => {
  const item = detail();
  expect(suggestionSchema.safeParse({ ...item.suggestions[0], value: 42 }).success).toBe(false);
  expect(detailSchema.safeParse({ ...item, selectedCoverSlotId: `embedded-${slotId}` }).success).toBe(false);
  expect(detailSchema.safeParse({ ...item, assets: [{ slotId: 'arbitrary', state: 'ready', sha256: 'a'.repeat(64), byteLength: 1, contentType: 'audio/mpeg', tags: null }] }).success).toBe(false);
});
test('Artist and Organization snapshots carry a nullable lowercase MusicBrainz ID that an edit sends only when changed', () => {
  const base = catalogAlbum(), mbid = '00000000-0000-4000-8000-0000000000a1';
  const artist = { ...base, kind: 'artist' as const, fields: { name: 'Synthetic Artist', bio: '', birthDate: null, musicBrainzId: null as string | null } };
  const organization = { ...base, kind: 'organization' as const, fields: { name: 'Synthetic Label', description: '', organizationType: 'label' as const, musicBrainzId: null as string | null } };
  for (const item of [artist, organization]) {
    for (const musicBrainzId of [null, mbid]) expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, musicBrainzId } }).success).toBe(true);
    for (const musicBrainzId of [mbid.toUpperCase(), 'not-an-id', 7]) expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, musicBrainzId } }).success).toBe(false);
    // A server that predates the field sends none, which reads as no ID.
    const { musicBrainzId: _id, ...older } = item.fields;
    expect((catalogItemSchema.parse({ ...item, fields: older }).fields as { musicBrainzId: string | null }).musicBrainzId).toBeNull();
  }
  expect(catalogItemSchema.safeParse({ ...base, fields: { ...base.fields, musicBrainzId: mbid } }).success).toBe(false);
  expect(catalogPatch(artist, { ...artist.fields, musicBrainzId: mbid }, 'public')).toEqual({ expectedRevision: artist.revision, fields: { musicBrainzId: mbid } });
  expect(catalogPatch({ ...artist, fields: { ...artist.fields, musicBrainzId: mbid } }, artist.fields, 'public')).toEqual({ expectedRevision: artist.revision, fields: { musicBrainzId: null } });
  expect(catalogPatch(artist, artist.fields, 'public')).not.toHaveProperty('fields');
});
