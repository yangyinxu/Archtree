import { catalogAlbumTracksSchema, expectedSummary, expectedSummaryVariables, type CatalogAlbumExpected } from './catalogAlbumTracksApi';
import { catalogAlbumTracks, catalogAlbumTracksWithExpected } from './catalogReviewFixtures.testSupport';

const expected = () => catalogAlbumTracksWithExpected().expected!;
const parses = (value: Partial<CatalogAlbumExpected> | Record<string, unknown> | null) =>
  catalogAlbumTracksSchema.safeParse({ ...catalogAlbumTracks(), expected: value }).success;
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ discNumber: 1, trackNumber: index + 1, title: `Synthetic row ${index + 1}`, durationMs: null, memberIds: [] }));
const first = '333333333333333333333333', second = '444444444444444444444444', missing = 'c2c2c2c2c2c2c2c2c2c2c2c2';

test('an absent, empty or matched expected tracklist parses, and an older server without the key reads as none', () => {
  expect(catalogAlbumTracksSchema.parse(catalogAlbumTracks()).expected).toBeNull();
  const { expected: _absent, ...older } = catalogAlbumTracks();
  expect(catalogAlbumTracksSchema.parse(older).expected).toBeNull();
  expect(catalogAlbumTracksSchema.parse(catalogAlbumTracksWithExpected()).expected).toEqual(expected());
  // An empty Album: every row has no file and nothing is outside.
  expect(catalogAlbumTracksSchema.safeParse({ ...catalogAlbumTracks(), tracks: [], expected: { ...expected(), rows: rows(100), outsideMemberIds: [] } }).success).toBe(true);
});

test.each([
  ['a release identity', { ...expected(), releaseId: 'synthetic' }],
  ['a recording identity on a row', { ...expected(), rows: expected().rows.map((row, index) => index ? row : { ...row, recordingId: 'synthetic' }) }],
  ['a MusicBrainz ID on a row', { ...expected(), rows: expected().rows.map((row, index) => index ? row : { ...row, musicBrainzId: '11111111-2222-4333-8444-555555555555' }) }],
  ['a MediaTrack reference on a row', { ...expected(), rows: expected().rows.map((row, index) => index ? row : { ...row, mediaTrackId: first }) }],
  ['an unknown source', { ...expected(), source: 'spotify' }],
  ['a relative date', { ...expected(), appliedAt: 'yesterday' }],
  ['a date without a time', { ...expected(), appliedAt: '2026-10-20' }],
  ['no rows', { ...expected(), rows: [] }],
  ['more than 100 rows', { ...expected(), rows: rows(101) }],
  ['unordered rows', { ...expected(), rows: [expected().rows[1], expected().rows[0], ...expected().rows.slice(2)] }],
  ['a repeated position', { ...expected(), rows: [expected().rows[0], { ...expected().rows[1], trackNumber: 1 }, ...expected().rows.slice(2)] }],
  ['disc 0', { ...expected(), rows: [{ ...expected().rows[0], discNumber: 0 }, ...expected().rows.slice(1)] }],
  ['disc 1000', { ...expected(), rows: [...expected().rows.slice(0, 3), { ...expected().rows[3], discNumber: 1000 }] }],
  ['track 0', { ...expected(), rows: [{ ...expected().rows[0], trackNumber: 0 }, ...expected().rows.slice(1)] }],
  ['track 10000', { ...expected(), rows: [...expected().rows.slice(0, 3), { ...expected().rows[3], trackNumber: 10000 }] }],
  ['an empty title', { ...expected(), rows: [{ ...expected().rows[0], title: '' }, ...expected().rows.slice(1)] }],
  ['a title over 300 characters', { ...expected(), rows: [{ ...expected().rows[0], title: 'x'.repeat(301) }, ...expected().rows.slice(1)] }],
  ['a zero duration', { ...expected(), rows: [{ ...expected().rows[0], durationMs: 0 }, ...expected().rows.slice(1)] }],
  ['a fractional duration', { ...expected(), rows: [{ ...expected().rows[0], durationMs: 1.5 }, ...expected().rows.slice(1)] }],
  ['a negative duration', { ...expected(), rows: [{ ...expected().rows[0], durationMs: -1 }, ...expected().rows.slice(1)] }]
])('the expected tracklist schema refuses %s', (_name, value) => {
  expect(parses(value)).toBe(false);
});

test.each([
  ['a member listed twice on rows', { rows: expected().rows.map((row, index) => index === 1 ? { ...row, memberIds: [first] } : row) }],
  ['a member on a row and outside', { outsideMemberIds: [second, first] }],
  ['a member in neither list', { outsideMemberIds: [] }],
  ['an unknown member', { outsideMemberIds: [second, 'f0f0f0f0f0f0f0f0f0f0f0f0'] }],
  ['the missing record outside', { outsideMemberIds: [second, missing] }],
  ['the missing record on a row', { rows: expected().rows.map((row, index) => index === 1 ? { ...row, memberIds: [missing] } : row) }]
])('every member with a record is placed exactly once: refuses %s', (_name, change) => {
  expect(parses({ ...expected(), ...change })).toBe(false);
});

test('a summary counts rows without a file and names its source and date for the viewer locale', () => {
  expect(expectedSummary(expected())).toEqual({ source: 'musicbrainz', appliedAt: '2026-10-20T12:00:00.000Z', rows: 4, noFile: 2 });
  expect(expectedSummaryVariables(expectedSummary(expected()), 'en-US')).toEqual({ source: 'MusicBrainz', date: 'Oct 20, 2026', rows: 4, noFile: 2 });
  // Source names are proper names and stay untranslated; the date follows the viewer's locale.
  expect(expectedSummaryVariables(expectedSummary({ ...expected(), source: 'itunes' }), 'zh-Hans')).toEqual({ source: 'iTunes', date: '2026年10月20日', rows: 4, noFile: 2 });
  expect(expectedSummary({ ...expected(), rows: expected().rows.map(row => ({ ...row, memberIds: row.memberIds.length ? row.memberIds : [second] })) }).noFile).toBe(0);
});

test('no release, recording, MusicBrainz or MediaTrack identity is accepted on the tracklist or on any row', () => {
  for (const key of ['releaseId', 'recordingId', 'musicBrainzId', 'mediaTrackId']) {
    expect(parses({ ...expected(), [key]: 'synthetic' }), `tracklist ${key}`).toBe(false);
    expect(parses({ ...expected(), rows: expected().rows.map((row, index) => index === 3 ? { ...row, [key]: 'synthetic' } : row) }), `row ${key}`).toBe(false);
  }
});

test('the bounds themselves parse, and the applied instant is a UTC timestamp with milliseconds as the server writes it', () => {
  const bounded = [{ discNumber: 1, trackNumber: 1, title: 'x'.repeat(300), durationMs: 1, memberIds: [first] },
    { discNumber: 999, trackNumber: 9999, title: 'y', durationMs: null, memberIds: [] }];
  expect(parses({ ...expected(), rows: bounded, outsideMemberIds: [second, 'c1c1c1c1c1c1c1c1c1c1c1c1'] })).toBe(true);
  for (const appliedAt of ['2026-10-20T12:00:00Z', '2026-10-20T20:00:00.000+08:00', '2026-10-20T12:00:00.000000Z'])
    expect(parses({ ...expected(), appliedAt }), appliedAt).toBe(false);
});

test('a member listed twice outside is refused, as on the rows', () => {
  expect(parses({ ...expected(), outsideMemberIds: [second, second] })).toBe(false);
});
