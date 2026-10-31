import { catalogReview, slotId, slotTwo } from './catalogReviewFixtures.testSupport';
import { longAlbum, recordEdits, withEdits, withProposedNumbers } from './catalogReviewEdits';

/** The review editor's sparse edits over the saved draft: writing them in, recording a change, and the draft a save writes. */

test('edits are written over the saved draft, a cleared value as null, and only values that differ from the draft shown are recorded', () => {
  const saved = catalogReview().draft;
  const edited = withEdits(saved, { album: { title: 'Edited' }, tracks: { [slotId]: { trackNumber: null } } });
  expect([edited.album.title, edited.album.artists, edited.tracks[0].trackNumber, edited.tracks[1]]).toEqual(['Edited', saved.album.artists, null, saved.tracks[1]]);
  const shown = { ...saved, tracks: saved.tracks.map(track => track.slotId === slotTwo ? { ...track, trackNumber: 2 } : track) };
  // A value left as shown, a proposal included, is not recorded; a changed one is, over the earlier edits.
  expect(recordEdits({ album: { title: 'Edited' } }, shown, shown)).toEqual({ album: { title: 'Edited' }, tracks: undefined });
  const next = { ...shown, album: { ...shown.album, releaseDate: { year: 2020, month: null, day: null } }, tracks: shown.tracks.map(track => ({ ...track, discNumber: 1 })) };
  expect(recordEdits({ album: { title: 'Edited' } }, shown, next)).toEqual({ album: { title: 'Edited', releaseDate: { year: 2020, month: null, day: null } },
    tracks: { [slotId]: { discNumber: 1 }, [slotTwo]: { discNumber: 1 } } });
});

test('a save writes the edits and only the selected proposed numbers that are still empty', () => {
  const saved = catalogReview().draft, numbers = { [slotId]: { discNumber: 1, trackNumber: 9 }, [slotTwo]: { discNumber: 1, trackNumber: 2 } };
  const draft = withProposedNumbers(saved, { tracks: { [slotTwo]: { discNumber: 3 } } }, numbers, key => key !== `track:${slotTwo}:trackNumber`);
  // The first member keeps its own Track Number; the second's deselected Track Number stays empty and its edit wins over the proposal.
  expect(draft.tracks.map(track => [track.discNumber, track.trackNumber])).toEqual([[1, 1], [3, null]]);
  expect([24, 25, 100].map(longAlbum)).toEqual([false, true, true]);
});
