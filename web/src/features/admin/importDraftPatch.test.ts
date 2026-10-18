import { applyChanges, artistByline, draftChanges, entriesByline, rebaseDraft, valueAt } from './importDraftPatch';
import { moveArtistEntry, setArtistEntryPhrase, setArtistEntryRole } from './importArtistEntries';
import { artistEntry, detail, entryKey, labelEntry, slotId, slotTwo } from './adminFixtures.testSupport';

const second = entryKey(2);

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

test('a reorder, role change or phrase edit sends the whole entry list as one change, and a label edit sends only album.label', () => {
  const base = detail().draft; base.album.artists = [{ ...artistEntry('Lorem'), joinPhrase: ' & ' }, artistEntry('Ipsum', second), artistEntry('Dolor', entryKey(3), 'featured')];
  const saved = base.album.artists, edit = (artists: typeof saved) => draftChanges(base, { ...base, album: { ...base.album, artists } });
  for (const artists of [moveArtistEntry(saved, second, -1), setArtistEntryRole(saved, second, 'featured'), setArtistEntryPhrase(saved, second, ' feat. ')]) {
    expect(edit(artists)).toEqual([{ path: 'album.artists', base: saved, value: artists }]);
  }
  // A move swaps the names while each join phrase stays in its position.
  expect(edit(moveArtistEntry(saved, second, -1))[0].value).toEqual([{ ...saved[1], joinPhrase: ' & ' }, { ...saved[0], joinPhrase: null }, saved[2]]);
  const labelled = { ...base, album: { ...base.album, label: labelEntry('Lorem Records') } };
  expect(draftChanges(base, labelled)).toEqual([{ path: 'album.label', base: null, value: labelEntry('Lorem Records') }]);
  expect(draftChanges(labelled, base)).toEqual([{ path: 'album.label', base: labelEntry('Lorem Records'), value: null }]);
});

test('entry edits rebase over another administrator\'s label save but not over another entries save', () => {
  const base = detail().draft; base.album.artists = [artistEntry('Lorem'), artistEntry('Ipsum', second)];
  const draft = { ...base, album: { ...base.album, artists: moveArtistEntry(base.album.artists, second, -1) } };
  const labelSaved = applyChanges(base, [{ path: 'album.label', base: null, value: labelEntry('Lorem Records') }]);
  const rebased = rebaseDraft(base, draft, labelSaved)!;
  expect(rebased.album).toMatchObject({ artists: draft.album.artists, label: labelEntry('Lorem Records') });
  expect(draftChanges(labelSaved, rebased)).toEqual([{ path: 'album.artists', base: base.album.artists, value: draft.album.artists }]);
  // Different entries saved elsewhere refuse the rebase, so the editor offers the saved version; the same entries do not.
  expect(rebaseDraft(base, draft, applyChanges(base, [{ path: 'album.artists', base: base.album.artists, value: [artistEntry('Lorem')] }]))).toBeNull();
  expect(draftChanges(draft, rebaseDraft(base, draft, applyChanges(base, [{ path: 'album.artists', base: base.album.artists, value: draft.album.artists }]))!)).toEqual([]);
});
