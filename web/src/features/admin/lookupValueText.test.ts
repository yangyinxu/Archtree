import { capturedCatalogReview, slotId, slotTwo } from './catalogReviewFixtures.testSupport';
import { lookupIdText, lookupValueAt, lookupValueText } from './lookupValueText';

/** How both summaries read a lookup path's saved value and show a value: entries, rows, labels, dates and plain values. */
const entry = (name: string, joinPhrase: string | null = null, musicBrainzId: string | null = null) =>
  ({ key: '50000000-0000-4000-8000-000000000009', name, role: 'primary', joinPhrase, musicBrainzId });

test('values read as bylines, expected rows, label names, dates or plain text, and nothing reads as a dash', () => {
  expect(lookupValueText([entry('Synthetic Lead', ' & '), entry('Synthetic Second')])).toBe('Synthetic Lead & Synthetic Second');
  expect(lookupValueText([entry('Synthetic Lead'), entry('Synthetic Second')])).toBe('Synthetic Lead, Synthetic Second');
  expect(lookupValueText([])).toBe('—');
  expect(lookupValueText([{ discNumber: 1, trackNumber: 1, title: 'First', durationMs: null }, { discNumber: 2, trackNumber: 3, title: 'Later', durationMs: 1000 }])).toBe('1.1 First · 2.3 Later');
  expect(lookupValueText({ name: 'Synthetic Label', musicBrainzId: null })).toBe('Synthetic Label');
  expect(lookupValueText({ year: 2020, month: 5, day: null })).toBe('2020-05');
  expect([lookupValueText('Title'), lookupValueText(7), lookupValueText(null), lookupValueText(undefined), lookupValueText('')]).toEqual(['Title', '7', '—', '—', '—']);
});

test('a conflict that differs only in MusicBrainz IDs shows each name with its ID', () => {
  const id = '00000000-0000-4000-8000-0000000000a1';
  expect(lookupIdText([entry('Synthetic Lead', null, id), entry('Synthetic Second')])).toBe(`Synthetic Lead · ${id}; Synthetic Second · —`);
  expect(lookupIdText({ name: 'Synthetic Label', musicBrainzId: id })).toBe(`Synthetic Label · ${id}`);
  expect(lookupIdText(null)).toBe('—');
});

test('each review path reads its saved value: Album values, the expected tracklist, member entries, and nothing for a missing track or field', () => {
  const draft = capturedCatalogReview().draft;
  expect(lookupValueAt(draft, 'album.title')).toBe('Synthetic catalog Album');
  expect(lookupValueAt(draft, 'album.label')).toBeNull();
  expect(lookupValueAt(draft, 'album.expectedTracklist')).toEqual(draft.album.expectedTracklist);
  expect(lookupValueAt(draft, `tracks.${slotId}.artists`)).toEqual(draft.tracks[0].artists);
  expect(lookupValueAt(draft, `tracks.${slotTwo}.artists`)).toEqual([]);
  expect(lookupValueAt(draft, `tracks.${slotId}.trackNumber`)).toBe(1);
  expect(lookupValueAt(draft, 'tracks.10000000-0000-4000-8000-000000000099.title')).toBeUndefined();
  const { expectedTracklist: _rows, ...album } = draft.album;
  expect(lookupValueAt({ ...draft, album }, 'album.expectedTracklist')).toBeUndefined();
});
