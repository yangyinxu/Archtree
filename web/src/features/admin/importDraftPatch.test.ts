import { applyChanges, artistByline, draftChanges, entriesByline, primaryArtistField, rebaseDraft, valueAt, withPrimaryArtistName } from './importDraftPatch';
import { artistEntry, detail, slotId, slotTwo } from './adminFixtures.testSupport';

const second = '30000000-0000-4000-8000-000000000002', mbid = '30000000-0000-4000-9000-000000000003';

test('a save sends only changed values, album values first and then tracks in saved order, each with its saved base', () => {
  const base = detail().draft, draft = structuredClone(base);
  expect(draftChanges(base, draft)).toEqual([]);
  draft.tracks[1].discNumber = 2; draft.tracks[0].title = 'First'; draft.album.visibility = 'hidden'; draft.album.artists = [artistEntry('Lorem')];
  expect(draftChanges(base, draft)).toEqual([
    { path: 'album.artists', base: [], value: [artistEntry('Lorem')] }, { path: 'album.visibility', base: 'public', value: 'hidden' },
    { path: `tracks.${slotId}.title`, base: '', value: 'First' }, { path: `tracks.${slotTwo}.discNumber`, base: null, value: 2 }
  ]);
  // Reordering the edited tracks changes nothing: tracks are matched by slot.
  expect(draftChanges(base, { ...base, tracks: [...base.tracks].reverse() })).toEqual([]);
});

test('a byline joins names with each join phrase, or a comma without one, and ignores the last phrase', () => {
  expect(entriesByline([])).toBe('');
  expect(entriesByline([{ name: 'A', joinPhrase: ' & ' }])).toBe('A');
  expect(entriesByline([{ name: 'A', joinPhrase: null }, { name: 'B', joinPhrase: ' feat. ' }, { name: 'C', joinPhrase: ' & ' }])).toBe('A, B feat. C');
  const draft = detail().draft; draft.album.artists = [{ ...artistEntry('Lorem'), joinPhrase: '\u3001' }, artistEntry('Ipsum', second)];
  expect(artistByline(draft)).toBe('Lorem\u3001Ipsum');
  expect(primaryArtistField(draft)).toEqual({ value: 'Lorem\u3001Ipsum', editable: false });
});

test('the Artist name field edits a single entry, creates one when empty and clears it, never touching several entries', () => {
  const empty = detail().draft;
  expect(primaryArtistField(empty)).toEqual({ value: '', editable: true });
  const created = withPrimaryArtistName(empty, 'Lorem').album.artists;
  expect(created).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), name: 'Lorem', role: 'primary', joinPhrase: null, musicBrainzId: null }]);
  expect(withPrimaryArtistName(empty, '   ').album.artists).toEqual([]);
  const single = detail().draft; single.album.artists = [{ ...artistEntry('Lorem'), role: 'featured', joinPhrase: ' & ', musicBrainzId: mbid }];
  expect(primaryArtistField(single)).toEqual({ value: 'Lorem', editable: true });
  // A rename keeps the key, role and phrase; the ID stays only while the name still matches case-insensitively.
  expect(withPrimaryArtistName(single, 'LOREM').album.artists).toEqual([{ ...single.album.artists[0], name: 'LOREM' }]);
  expect(withPrimaryArtistName(single, 'Ipsum').album.artists).toEqual([{ ...single.album.artists[0], name: 'Ipsum', musicBrainzId: null }]);
  expect(withPrimaryArtistName(single, '').album.artists).toEqual([]);
  expect(single.album.artists[0].name).toBe('Lorem');
  const several = detail().draft; several.album.artists = [artistEntry('Lorem'), artistEntry('Ipsum', second)];
  expect(withPrimaryArtistName(several, 'Other')).toBe(several);
});

test('clearing the single entry and typing again brings back the saved entry, so retyping its name changes nothing', () => {
  const base = detail().draft; base.album.artists = [{ ...artistEntry('Synthetic Artist'), role: 'featured', joinPhrase: ' & ', musicBrainzId: mbid }];
  const [saved] = base.album.artists, cleared = withPrimaryArtistName(base, '', saved);
  expect(cleared.album.artists).toEqual([]);
  // Each keystroke after clearing keeps the saved key, role and phrase; the ID returns once the name matches again.
  const typing = withPrimaryArtistName(cleared, 'S', saved), retyped = withPrimaryArtistName(typing, 'Synthetic Artist', saved);
  expect(typing.album.artists).toEqual([{ ...saved, name: 'S', musicBrainzId: null }]);
  expect(retyped.album.artists).toEqual([saved]); expect(draftChanges(base, retyped)).toEqual([]);
  expect(withPrimaryArtistName(cleared, 'SYNTHETIC artist', saved).album.artists).toEqual([{ ...saved, name: 'SYNTHETIC artist' }]);
  expect(withPrimaryArtistName(cleared, 'Renamed', saved).album.artists).toEqual([{ ...saved, name: 'Renamed', musicBrainzId: null }]);
  // Without a saved entry a new primary entry is created.
  expect(withPrimaryArtistName(cleared, 'Renamed').album.artists[0]).toMatchObject({ name: 'Renamed', role: 'primary', joinPhrase: null, musicBrainzId: null });
  expect(withPrimaryArtistName(cleared, 'Renamed').album.artists[0].key).not.toBe(saved.key);
});

test('a newer saved draft rebases unsaved edits path by path, and a changed edited path refuses the rebase', () => {
  const base = detail().draft, draft = structuredClone(base); draft.album.title = 'Mine'; draft.tracks[0].discNumber = 2;
  expect(valueAt(base, 'album.title')).toBe(''); expect(valueAt(base, `tracks.${slotTwo}.trackNumber`)).toBeNull(); expect(valueAt(base, 'tracks.unknown.title')).toBeUndefined();
  const other = applyChanges(base, [{ path: `tracks.${slotTwo}.title`, base: '', value: 'Theirs' }, { path: 'album.visibility', base: 'public', value: 'hidden' }]);
  expect([other.tracks[1].title, other.album.visibility, base.tracks[1].title]).toEqual(['Theirs', 'hidden', '']);
  // Other paths saved elsewhere: the edits move onto the newer draft and still send only their own paths.
  const rebased = rebaseDraft(base, draft, other)!;
  expect([rebased.album.title, rebased.tracks[0].discNumber, rebased.tracks[1].title, rebased.album.visibility]).toEqual(['Mine', 2, 'Theirs', 'hidden']);
  expect(draftChanges(other, rebased)).toEqual([{ path: 'album.title', base: '', value: 'Mine' }, { path: `tracks.${slotId}.discNumber`, base: null, value: 2 }]);
  // The same value saved elsewhere is no conflict and leaves only the other edit.
  const agreed = applyChanges(other, [{ path: 'album.title', base: '', value: 'Mine' }]);
  expect(draftChanges(agreed, rebaseDraft(base, draft, agreed)!)).toEqual([{ path: `tracks.${slotId}.discNumber`, base: null, value: 2 }]);
  // Another value saved on an edited path keeps the conflict.
  expect(rebaseDraft(base, draft, applyChanges(other, [{ path: 'album.title', base: '', value: 'Theirs' }]))).toBeNull();
  expect(rebaseDraft(base, base, other)).toEqual(other);
});
