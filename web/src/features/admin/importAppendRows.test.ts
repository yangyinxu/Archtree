import { appendNumberingChanges, appendRowPlacements } from './importAppendRows';
import type { ImportAppendTracklist } from './importLookupApi';
import { detail, slotId, slotTwo } from './adminFixtures.testSupport';

/**
 * Placing an append's shown files on the target Album's expected tracklist as the server places members, the flags in their fixed
 * order, the counts, and the field-save changes of the one-step numbering. All titles and identifiers are synthetic.
 */
const slotThree = '10000000-0000-4000-8000-000000000003';
const row = (discNumber: number, trackNumber: number, durationMs: number | null = null, filled = false) => ({ discNumber, trackNumber, title: `Row ${discNumber}-${trackNumber}`, durationMs, filled });
const tracklist = (rows: ImportAppendTracklist['rows'], files: ImportAppendTracklist['files'] = [], numbering: ImportAppendTracklist['numbering'] = []): ImportAppendTracklist =>
  ({ albumId: 'a'.repeat(24), durationToleranceMs: 3000, rows, files, numbering });
const file = (slot: string, discNumber: number | null, trackNumber: number | null) => ({ slotId: slot, discNumber, trackNumber });
const duration = (slot: string, durationMs: number | null, durationPrecisionMs: 0 | 1000 = 0) => ({ slotId: slot, durationMs, durationPrecisionMs, appended: true });

test('each flag is listed in its fixed order: no Track Number, no Disc Number, outside, already filled, duration', () => {
  const twoDiscs = tracklist([row(1, 1, 200_000, true), row(1, 2), row(2, 1)], [duration(slotId, 100_000), duration(slotTwo, null)]);
  const placed = appendRowPlacements(twoDiscs, [file(slotId, null, 1), file(slotTwo, null, null), file(slotThree, 1, 9)]);
  // A missing Disc Number counts as disc 1, so the first file reaches the filled (1, 1) and its duration is far off.
  expect(placed.files.map(item => [item.slotId, item.row && [item.row.discNumber, item.row.trackNumber], item.flags])).toEqual([
    [slotId, [1, 1], ['noDiscNumber', 'alreadyFilled', 'duration']], [slotTwo, null, ['noTrackNumber', 'noDiscNumber']], [slotThree, null, ['outside']]]);
  // On a single-disc tracklist a missing Disc Number is no flag.
  expect(appendRowPlacements(tracklist([row(1, 1), row(1, 2)]), [file(slotId, null, 2)]).files[0].flags).toEqual([]);
  expect(appendRowPlacements(tracklist([row(1, 1), row(1, 2)]), [file(slotId, null, null)]).files[0].flags).toEqual(['noTrackNumber']);
});

test('a row is already filled by a member or when two listed files reach it, and the counts are distinct missing-file rows', () => {
  const rows = [row(1, 1, null, true), row(1, 2), row(1, 3), row(1, 4)];
  const placed = appendRowPlacements(tracklist(rows), [file(slotId, 1, 2), file(slotTwo, null, 2), file(slotThree, 1, 3)]);
  expect(placed.files.map(item => item.flags)).toEqual([['alreadyFilled'], ['alreadyFilled'], []]);
  expect([placed.filledRows, placed.missingRows]).toEqual([2, 3]);
  // A file on a filled row fills no missing-file row.
  const member = appendRowPlacements(tracklist(rows), [file(slotId, 1, 1)]);
  expect([member.files[0].flags, member.filledRows, member.missingRows]).toEqual([['alreadyFilled'], 0, 3]);
  expect(appendRowPlacements(tracklist(rows), [])).toEqual({ files: [], filledRows: 0, missingRows: 3 });
});

test('a duration is flagged only above the tolerance, a legacy whole-second duration gets one more second, and an unknown side is never flagged', () => {
  const flags = (fileMs: number | null, rowMs: number | null, precision: 0 | 1000 = 0) =>
    appendRowPlacements(tracklist([row(1, 1, rowMs)], [duration(slotId, fileMs, precision)]), [file(slotId, 1, 1)]).files[0].flags;
  expect(flags(203_000, 200_000)).toEqual([]);
  expect(flags(196_999, 200_000)).toEqual(['duration']);
  expect(flags(203_001, 200_000)).toEqual(['duration']);
  expect(flags(204_000, 200_000, 1000)).toEqual([]);
  expect(flags(204_001, 200_000, 1000)).toEqual(['duration']);
  expect(flags(null, 200_000)).toEqual([]);
  expect(flags(900_000, null)).toEqual([]);
  // A file the server lists no duration for is never flagged either.
  expect(appendRowPlacements(tracklist([row(1, 1, 200_000)]), [file(slotId, 1, 1)]).files[0].flags).toEqual([]);
});

test('the numbering is one field save against the saved values, a row title only where one is proposed, and unknown slots are skipped', () => {
  const saved = detail().draft;
  saved.tracks[0] = { ...saved.tracks[0], title: 'Tag Title', discNumber: 2, trackNumber: 7 }; saved.tracks[1] = { ...saved.tracks[1], title: 'Mine' };
  const numbering = [{ slotId, discNumber: 1, trackNumber: 5, title: 'Row 1-5' }, { slotId: slotTwo, discNumber: 1, trackNumber: 6, title: null }, { slotId: slotThree, discNumber: 1, trackNumber: 7, title: 'Gone' }];
  expect(appendNumberingChanges(tracklist([row(1, 5), row(1, 6)], [], numbering), saved)).toEqual([
    { path: `tracks.${slotId}.discNumber`, base: 2, value: 1 }, { path: `tracks.${slotId}.trackNumber`, base: 7, value: 5 }, { path: `tracks.${slotId}.title`, base: 'Tag Title', value: 'Row 1-5' },
    { path: `tracks.${slotTwo}.discNumber`, base: null, value: 1 }, { path: `tracks.${slotTwo}.trackNumber`, base: null, value: 6 }]);
  expect(appendNumberingChanges(tracklist([row(1, 5)]), saved)).toEqual([]);
});
