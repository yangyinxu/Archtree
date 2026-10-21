import type { ImportDraftV2 } from './adminNamingSchema';
import type { ImportDraftChange } from './importDraftPatch';
import type { ImportAppendTracklist } from './importLookupApi';

/**
 * Where the shown files of an append land on the target Album's expected tracklist, as the server's expectedTrackPosition places
 * members (no Track Number is no position, a missing Disc Number is disc 1), with the flags the summary and the confirmation show,
 * and the field-save changes of the server's one-step numbering. Pure, and type-only imports keep the schemas out of its chunk.
 */
export type AppendRowFlag = 'noTrackNumber' | 'noDiscNumber' | 'outside' | 'alreadyFilled' | 'duration';
export interface AppendRowPlacement { slotId: string; row: ImportAppendTracklist['rows'][number] | null; flags: AppendRowFlag[] }

const key = (discNumber: number, trackNumber: number) => `${discNumber}:${trackNumber}`;

/**
 * Each listed file's row and flags, always in AppendRowFlag order: no Track Number; no Disc Number while the rows span several
 * discs; a position no row has; a row a member already fills or that another listed file also reaches; a duration that differs
 * from the row's by more than the tolerance plus the file's precision (both known). `filledRows` counts the missing-file rows
 * the files reach and `missingRows` all missing-file rows; flags never hold Publish.
 */
export function appendRowPlacements(tracklist: ImportAppendTracklist, files: readonly { slotId: string; discNumber: number | null; trackNumber: number | null }[]):
  { files: AppendRowPlacement[]; filledRows: number; missingRows: number } {
  const rows = new Map(tracklist.rows.map(row => [key(row.discNumber, row.trackNumber), row]));
  const discs = new Set(tracklist.rows.map(row => row.discNumber)).size;
  const reached = files.map(file => file.trackNumber === null ? null : rows.get(key(file.discNumber ?? 1, file.trackNumber)) ?? null);
  const placements = files.map((file, index): AppendRowPlacement => {
    const row = reached[index], duration = tracklist.files.find(item => item.slotId === file.slotId), flags: AppendRowFlag[] = [];
    if (file.trackNumber === null) flags.push('noTrackNumber');
    if (file.discNumber === null && discs > 1) flags.push('noDiscNumber');
    if (file.trackNumber !== null && !row) flags.push('outside');
    if (row && (row.filled || reached.filter(other => other === row).length > 1)) flags.push('alreadyFilled');
    if (row && row.durationMs !== null && duration && duration.durationMs !== null
      && Math.abs(duration.durationMs - row.durationMs) > tracklist.durationToleranceMs + duration.durationPrecisionMs) flags.push('duration');
    return { slotId: file.slotId, row, flags };
  });
  return { files: placements, filledRows: new Set(reached.filter(row => row && !row.filled)).size, missingRows: tracklist.rows.filter(row => !row.filled).length };
}

/** The numbering as one field save against the saved draft: Disc and Track Number, and the row title where one is proposed; unknown slots are skipped. */
export function appendNumberingChanges(tracklist: ImportAppendTracklist, saved: ImportDraftV2): ImportDraftChange[] {
  return tracklist.numbering.flatMap(entry => {
    const track = saved.tracks.find(item => item.slotId === entry.slotId);
    if (!track) return [];
    const path = (field: string) => `tracks.${entry.slotId}.${field}`;
    return [{ path: path('discNumber'), base: track.discNumber, value: entry.discNumber }, { path: path('trackNumber'), base: track.trackNumber, value: entry.trackNumber },
      ...entry.title === null ? [] : [{ path: path('title'), base: track.title, value: entry.title }]];
  });
}
