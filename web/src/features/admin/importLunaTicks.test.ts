import { suggestionPath, suggestionTicks, ticked, tickedDraft, type LunaTick } from './importLunaTicks';
import { artistEntry, detail, slotId } from './adminFixtures.testSupport';
import type { ImportSuggestionV2 } from './adminApi';

/** The fixture's pending Album title and first-track number suggestions, plus an Artist suggestion. */
const suggestions = (): ImportSuggestionV2[] => [...detail().suggestions,
  { id: 'e'.repeat(24), generation: 1, scope: 'album', slotId: null, field: 'artists', baseline: [], value: [artistEntry('Luna Lead')], source: 'context', evidence: 'Synthetic', decision: 'pending' }];
const title = 'c'.repeat(24), number = 'd'.repeat(24), artists = 'e'.repeat(24);

test('a suggestion is ticked by its server default unless toggled, and never when resolved, a conflict, unknown or changed in this approval', () => {
  const [album] = suggestions();
  expect(suggestionPath(album)).toBe('album.title'); expect(suggestionPath(suggestions()[1])).toBe(`tracks.${slotId}.trackNumber`);
  expect(['ticked', 'unticked', 'resolved', 'conflict', undefined].map(tick => ticked(album, tick as LunaTick | undefined, {}))).toEqual([true, false, false, false, false]);
  expect(ticked(album, 'ticked', { [title]: false })).toBe(false); expect(ticked(album, 'unticked', { [title]: true })).toBe(true);
  expect(ticked(album, 'conflict', { [title]: true })).toBe(false); expect(ticked(album, 'resolved', { [title]: true })).toBe(false);
  expect(ticked(album, 'ticked', {}, new Set(['album.title']))).toBe(false);
});

test('the approval lists every pending suggestion once, ticked or unticked, for its generation, and the shown draft carries the ticked values', () => {
  const item = { ...detail(), suggestions: [...suggestions(), { ...suggestions()[0], id: 'f'.repeat(24), decision: 'accepted' as const }] };
  const ticks = new Map<string, LunaTick>([[title, 'ticked'], [number, 'resolved'], [artists, 'unticked']]);
  expect(suggestionTicks(item, ticks, {}, new Set())).toEqual({ generation: 1, ticked: [title], unticked: [number, artists] });
  expect(suggestionTicks(item, ticks, { [title]: false, [artists]: true }, new Set())).toEqual({ generation: 1, ticked: [artists], unticked: [title, number] });
  expect(suggestionTicks(item, ticks, {}, new Set(['album.title']))).toEqual({ generation: 1, ticked: [], unticked: [title, number, artists] });
  const shown = tickedDraft(item.draft, item.suggestions, [title, number, artists]);
  expect([shown.album.title, shown.tracks[0].trackNumber, shown.album.artists.map(entry => entry.name)]).toEqual(['Suggested Album', 1, ['Luna Lead']]);
  // The editor's draft itself is never changed.
  expect([item.draft.album.title, item.draft.album.artists]).toEqual(['', []]);
  expect(tickedDraft(item.draft, item.suggestions, [])).toEqual(item.draft);
});
