import type { ImportDecision, ImportDraftV2 } from './adminApi';
import { candidatesSchema, duplicateFileSlots, identityPreselections, sameName, type ImportCandidate, type ImportCandidates } from './importIdentity';
import { artistEntry, detail, entryKey, labelEntry, slotId, slotTwo } from './adminFixtures.testSupport';

/** Two entries, a label and two titled tracks, as saved. */
function saved(): ImportDraftV2 {
  const draft = detail().draft;
  draft.album = { ...draft.album, title: 'Synthetic Album', artists: [artistEntry('Lorem'), artistEntry('Ipsum', entryKey(2), 'featured')], label: labelEntry('Sit Records') };
  draft.tracks = [{ slotId, title: 'First', discNumber: null, trackNumber: 1 }, { slotId: slotTwo, title: 'Second', discNumber: null, trackNumber: 2 }];
  return draft;
}
const target = '3'.repeat(24), otherAlbum = '6'.repeat(24);
let next = 0;
const candidate = (kind: ImportCandidate['kind'], label: string, change: Partial<ImportCandidate> = {}): ImportCandidate =>
  ({ kind, id: (++next).toString(16).padStart(24, '0'), label, revision: `r-${next}`, albumId: null, visibility: 'public', match: 'name', matchedSlotIds: [], automaticReuse: false, ...change });
const listing = (items: ImportCandidate[], memberMatchesComplete = true, unavailable: ImportCandidates['unavailable'] = []): ImportCandidates => ({ items, memberMatchesComplete, unavailable });
const decision = (scope: ImportDecision['scope'], change: Partial<ImportDecision> = {}): ImportDecision =>
  ({ scope, slotId: null, entryKey: null, boundName: null, action: 'create-distinct', candidateId: null, candidateRevision: null, ...change });
const appendTo = (...tracks: ImportDecision[]) => [decision('album', { action: 'reuse', candidateId: target, candidateRevision: 'r-target' }), ...tracks];
/** Each preselection as `scope:slot-or-entry:action[:candidate]`. */
const rows = (decisions: readonly ImportDecision[]) => decisions.map(value => [value.scope, value.slotId ?? value.entryKey ?? '-', value.action, ...(value.candidateId ? [value.candidateId] : [])].join(':'));

test('the candidates schema accepts 860 items and 22 unavailable names, defaulting an absent member flag to incomplete and absent names to none, and refuses more, unknown keys and automatic reuse', () => {
  const item = candidate('organization', 'Sit Records', { visibility: 'hidden' }), name = { kind: 'artist', label: 'Lorem' };
  expect(candidatesSchema.parse({ items: [item] })).toEqual({ items: [item], memberMatchesComplete: false, unavailable: [] });
  expect(candidatesSchema.safeParse({ items: Array(860).fill(item), memberMatchesComplete: true, unavailable: Array(22).fill(name) }).success).toBe(true);
  for (const body of [{ items: Array(861).fill(item) }, { items: [{ ...item, kind: 'label' }] }, { items: [{ ...item, automaticReuse: true }] }, { items: [], memberMatchesComplete: true, extra: 1 }, { items: [{ ...item, extra: 1 }] },
    { items: [], unavailable: Array(23).fill(name) }, { items: [], unavailable: [{ ...name, kind: 'track' }] }, { items: [], unavailable: [{ ...name, id: item.id }] }])
    expect(candidatesSchema.safeParse(body).success).toBe(false);
});

test('a same-name record too malformed to be a candidate holds its row, and names compare as the server does whatever the browser locale', () => {
  const draft = saved();
  expect(rows(identityPreselections(draft, draft, [], listing([], true, [{ kind: 'artist', label: 'LOREM' }, { kind: 'album', label: 'synthetic album' }]))))
    .toEqual([`artist:${entryKey(2)}:create-distinct`, 'label:-:create-distinct']);
  // Under a Turkish locale 'I' lowers to a dotless i; the comparison never uses the locale.
  const lower = String.prototype.toLocaleLowerCase, turkish = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) { return lower.call(this, 'tr'); });
  try {
    expect('IPSUM'.toLocaleLowerCase()).not.toBe('ipsum'.toLocaleLowerCase());
    expect(sameName('IPSUM', 'ipsum')).toBe(true);
    const lowered = saved(); lowered.album.artists[1].name = 'ipsum';
    expect(rows(identityPreselections(lowered, lowered, [], listing([candidate('artist', 'IPSUM')]))).filter(row => row.startsWith('artist'))).toEqual([`artist:${entryKey(1)}:create-distinct`]);
  } finally { turkish.mockRestore(); }
});

test('with no candidates every saved row is preselected as new, an explicit decision wins, and a name candidate holds only its own row', () => {
  const draft = saved();
  expect(rows(identityPreselections(draft, draft, [], listing([])))).toEqual([`artist:${entryKey(1)}:create-distinct`, `artist:${entryKey(2)}:create-distinct`, 'label:-:create-distinct',
    'album:-:create-distinct', `track:${slotId}:create-distinct`, `track:${slotTwo}:create-distinct`]);
  expect(identityPreselections(draft, draft, [], listing([]))[0]).toEqual(decision('artist', { entryKey: entryKey(1), boundName: 'Lorem' }));
  expect(rows(identityPreselections(draft, draft, [decision('artist', { entryKey: entryKey(1), boundName: 'Lorem', action: 'skip' }), decision('label', { boundName: 'Sit Records' }), decision('track', { slotId, action: 'skip' })], listing([]))))
    .toEqual([`artist:${entryKey(2)}:create-distinct`, 'album:-:create-distinct', `track:${slotTwo}:create-distinct`]);
  // Case-insensitive names of the same kind only: an Artist named like the label holds nothing.
  expect(rows(identityPreselections(draft, draft, [], listing([candidate('artist', 'LOREM'), candidate('artist', 'sit records')]))).slice(0, 2)).toEqual([`artist:${entryKey(2)}:create-distinct`, 'label:-:create-distinct']);
  // An Album candidate holds the Album and its tracks; an explicit create preselects the tracks, a skip none.
  const album = candidate('album', 'synthetic album');
  expect(rows(identityPreselections(draft, draft, [], listing([album])))).toEqual([`artist:${entryKey(1)}:create-distinct`, `artist:${entryKey(2)}:create-distinct`, 'label:-:create-distinct']);
  expect(rows(identityPreselections(draft, draft, [decision('album')], listing([album]))).slice(3)).toEqual([`track:${slotId}:create-distinct`, `track:${slotTwo}:create-distinct`]);
  expect(identityPreselections(draft, draft, [decision('album', { action: 'skip' })], listing([])).some(value => value.scope === 'track')).toBe(false);
});

test('a row shown under another name than the saved one is never preselected: a renamed entry or label, a changed title or a new unsaved entry', () => {
  const draft = saved(), shown = structuredClone(draft);
  shown.album.artists = [{ ...draft.album.artists[0], name: 'Lorem Renamed' }, draft.album.artists[1], artistEntry('Dolor', entryKey(3))];
  shown.album.label = labelEntry('Sit Records Ltd'); shown.album.title = 'Retitled Album';
  expect(rows(identityPreselections(shown, draft, [], listing([])))).toEqual([`artist:${entryKey(2)}:create-distinct`]);
  // In an append, a changed track title is not preselected either.
  const retitled = structuredClone(draft); retitled.tracks[0].title = 'Retitled';
  expect(rows(identityPreselections(retitled, draft, appendTo(), listing([])))).toEqual([`track:${slotTwo}:create-distinct`]);
});

test('when appending, identical bytes on the target preselect reuse, a title-only member needs a choice, ambiguity and incomplete matches preselect nothing', () => {
  const draft = saved(), member = candidate('track', 'Stored', { albumId: target, match: 'sha256', matchedSlotIds: [slotId] });
  expect(identityPreselections(draft, draft, appendTo(), listing([member]))).toEqual([decision('track', { slotId, action: 'reuse', candidateId: member.id, candidateRevision: member.revision }), decision('track', { slotId: slotTwo })]);
  expect(rows(identityPreselections(draft, draft, appendTo(), listing([candidate('track', 'SECOND', { albumId: target })])))).toEqual([`track:${slotId}:create-distinct`]);
  // Bytes on another Album are only a flag.
  expect(rows(identityPreselections(draft, draft, appendTo(), listing([candidate('track', 'First', { albumId: otherAlbum, match: 'sha256', matchedSlotIds: [slotId] })])))).toEqual([`track:${slotId}:create-distinct`, `track:${slotTwo}:create-distinct`]);
  expect(identityPreselections(draft, draft, appendTo(), listing([{ ...member, matchedSlotIds: [slotId, slotTwo] }]))).toEqual([]);
  expect(rows(identityPreselections(draft, draft, appendTo(), listing([member, { ...member, id: '7'.repeat(24) }])))).toEqual([`track:${slotTwo}:create-distinct`]);
  expect(identityPreselections(draft, draft, appendTo(decision('track', { slotId: slotTwo, action: 'reuse', candidateId: member.id, candidateRevision: member.revision })), listing([member]))).toEqual([]);
  expect(identityPreselections(draft, draft, appendTo(), listing([member], false))).toEqual([]);
});

test('identical bytes outside the append target flag their files, and a byte match on the target flags nothing', () => {
  const onTarget = candidate('track', 'Stored', { albumId: target, match: 'sha256', matchedSlotIds: [slotId] }), elsewhere = candidate('track', 'Other', { albumId: otherAlbum, match: 'sha256', matchedSlotIds: [slotTwo] });
  const loose = candidate('track', 'Loose', { match: 'sha256', matchedSlotIds: [slotId] }), named = candidate('track', 'Second', { albumId: otherAlbum, matchedSlotIds: [slotTwo] });
  expect([...duplicateFileSlots(appendTo(), listing([onTarget, elsewhere, named]))]).toEqual([slotTwo]);
  expect([...duplicateFileSlots([], listing([onTarget, loose]))]).toEqual([slotId]);
  expect([...duplicateFileSlots(appendTo(), listing([loose]))]).toEqual([slotId]);
});

test('an untitled file is never matched by title when appending, so an untitled member holds only the file its bytes match', () => {
  const draft = saved(); draft.tracks[0].title = '';
  const untitled = candidate('track', '', { albumId: target, match: 'sha256', matchedSlotIds: [slotTwo] });
  expect(rows(identityPreselections(draft, draft, appendTo(), listing([untitled])))).toEqual([`track:${slotId}:create-distinct`, `track:${slotTwo}:reuse:${untitled.id}`]);
});
