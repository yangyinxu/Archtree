import { lookupResponseSchema, lookupViewSchema } from './importLookupApi';

const slot = '10000000-0000-4000-8000-000000000001', slotTwo = '10000000-0000-4000-8000-000000000002';
const release = '0000000b-0000-4000-8000-000000000001', key = `musicbrainz:${release}`, groupKey = 'a'.repeat(64);
const entry = (name: string, keyNumber: number, joinPhrase: string | null = null) =>
  ({ key: `30000000-0000-4000-8000-00000000000${keyNumber}`, name, role: 'primary', joinPhrase, musicBrainzId: null });
/** A view shaped as the server's allowlist returns it (src/administration/lookup/lookupView.ts), with one answered and one open conflict. */
const view = () => ({
  run: 2, state: 'complete', issue: null, outcome: 'candidates', input: { trigger: 'submitted', submitted: { kind: 'album', text: 'Synthetic Album' } },
  candidates: [{ key, releaseId: release, status: 'matching', title: 'Synthetic Album', artist: 'Synthetic Lead & Synthetic Second', label: 'Synthetic Label',
    catalogNumber: 'SYN-001', barcode: '4006381333931', country: 'JP', date: { year: 2021, month: 5, day: 1 }, formats: ['CD'], trackCount: 2,
    comparison: { trackCount: { local: 2, candidate: 2 }, discCount: { local: null, candidate: 1 }, differences: [], unknownLocalDurations: 0, unknownCandidateDurations: 0 },
    groupKey, artistMismatch: false }],
  groups: [{ groupKey, representativeKey: key, memberKeys: [key], proposal: { albumTitle: 'Synthetic Album',
    artists: [{ name: 'Synthetic Lead', role: 'primary', joinPhrase: ' & ' }, { name: 'Synthetic Second', role: 'primary', joinPhrase: null }], label: 'Synthetic Label',
    releaseDate: { year: 2020, month: null, day: null }, tracks: [{ discNumber: 1, trackNumber: 1, title: 'First Song' }, { discNumber: 1, trackNumber: 2, title: 'Second Song' }] } }],
  preselection: { candidateKey: key, basis: 'onlyMatchingGroup', artistMismatch: false },
  disclosure: { unknownLocalDurations: 0, unknownLocalDiscNumbers: 2 },
  applied: { run: 2, candidateKey: key, releaseId: release, choice: 'preselected', basis: 'onlyMatchingGroup',
    values: [{ path: 'album.title', slotId: null }, { path: `tracks.${slot}.title`, slotId: slot }],
    conflicts: [{ path: 'album.label', slotId: null, lookup: { name: 'Synthetic Label', musicBrainzId: null }, answer: null },
      { path: 'album.artists', slotId: null, lookup: [entry('Synthetic Lead', 1, ' & '), entry('Synthetic Second', 2)], answer: 'mine' },
      { path: `tracks.${slotTwo}.trackNumber`, slotId: slotTwo, lookup: 2, answer: null }],
    flagged: [{ path: 'album.releaseDate', reason: 'format' }] },
  staleFiles: [slotTwo], needsAnswer: { tie: false, conflicts: ['album.label', `tracks.${slotTwo}.trackNumber`] }, blocking: true
});

/** The summary state as src/administration/import/adminImportSummary.ts returns it. */
const summary = () => ({ append: false, waiting: { uploads: false, lookup: true, analysis: false }, placeholderOnly: false,
  luna: [{ id: 'c'.repeat(24), tick: 'ticked' }, { id: 'd'.repeat(24), tick: 'conflict' }], analysis: { runs: 1, attempts: 20, daily: 218 }, lookupAvailable: true, identityAnswers: 2 });

test('a server-shaped lookup view parses strictly, before any run as null too', () => {
  expect(lookupResponseSchema.safeParse({ lookup: view(), revision: 7, valueRevision: 3, summary: summary() }).success).toBe(true);
  expect(lookupResponseSchema.safeParse({ lookup: null, revision: 1, valueRevision: 0, summary: summary() }).success).toBe(true);
  expect(lookupViewSchema.safeParse({ ...view(), applied: null, preselection: null, disclosure: null, candidates: [], groups: [] }).success).toBe(true);
});

test('extra keys, links, forged paths, unknown states and oversized lists are refused', () => {
  const item = view();
  const refused = (value: unknown) => expect(lookupViewSchema.safeParse(value).success).toBe(false);
  refused({ ...item, fence: 3 });
  refused({ ...item, candidates: [{ ...item.candidates[0], url: 'https://musicbrainz.org/release/x' }] });
  refused({ ...item, candidates: [{ ...item.candidates[0], artworkUrl: 'https://is1-ssl.mzstatic.com/x.jpg' }] });
  refused({ ...item, applied: { ...item.applied, actorId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
  refused({ ...item, applied: { ...item.applied, values: [{ path: 'album.visibility', slotId: null }] } });
  refused({ ...item, applied: { ...item.applied, values: [{ path: 'tracks.not-a-slot.title', slotId: null }] } });
  refused({ ...item, needsAnswer: { tie: false, conflicts: ['__proto__'] } });
  refused({ ...item, applied: { ...item.applied, conflicts: [{ ...item.applied.conflicts[0], lookup: { name: 'x', musicBrainzId: null, url: 'https://example.invalid' } }] } });
  refused({ ...item, state: 'paused' });
  refused({ ...item, candidates: [{ ...item.candidates[0], key: 'itunes:1' }] });
  refused({ ...item, candidates: Array.from({ length: 26 }, () => item.candidates[0]) });
  refused({ ...item, groups: Array.from({ length: 26 }, () => item.groups[0]) });
  refused({ ...item, candidates: [{ ...item.candidates[0], formats: Array.from({ length: 21 }, () => 'CD') }] });
  refused({ ...item, candidates: [{ ...item.candidates[0], title: 't'.repeat(1001) }] });
  refused({ ...item, applied: { ...item.applied, flagged: Array.from({ length: 306 }, () => item.applied.flagged[0]) } });
  expect(lookupResponseSchema.safeParse({ lookup: item, revision: 1, valueRevision: 0, summary: summary(), records: [] }).success).toBe(false);
});

test('the summary state is strict: no missing or extra field, unknown tick or forged suggestion ID', () => {
  const refused = (value: unknown) => expect(lookupResponseSchema.safeParse({ lookup: null, revision: 1, valueRevision: 0, summary: value }).success).toBe(false);
  const item = summary();
  expect(lookupResponseSchema.safeParse({ lookup: null, revision: 1, valueRevision: 0 }).success).toBe(false);
  refused({ ...item, publishable: true });
  refused({ ...item, waiting: { ...item.waiting, cover: true } });
  refused({ ...item, luna: [{ id: 'c'.repeat(24), tick: 'maybe' }] });
  refused({ ...item, luna: [{ id: '__proto__', tick: 'ticked' }] });
  refused({ ...item, analysis: { runs: -1, attempts: 0, daily: 0 } });
  refused({ ...item, placeholderOnly: undefined });
  refused({ ...item, lookupAvailable: undefined }); refused({ ...item, identityAnswers: 1.5 }); refused({ ...item, identityAnswers: -1 });
});
