import { entriesByline } from './artistEntriesByline';
import { reviewValueText } from './reviewValueText';

/**
 * How an import's or existing-Album review's summary reads and shows a lookup value: the saved draft value at a lookup path and
 * its text. Pure; shared by both summaries so neither chunk carries the other.
 */

/** A lookup path's value in a draft (`album.<field>` or `tracks.<slotId>.<field>`), member entries and the expected tracklist included. */
export const lookupValueAt = (draft: { album: object; tracks: readonly { slotId: string }[] }, path: string): unknown => {
  const [scope, first, second] = path.split('.');
  return scope === 'album' ? (draft.album as Record<string, unknown>)[first] : (draft.tracks.find(track => track.slotId === first) as Record<string, unknown> | undefined)?.[second];
};
/** An expected tracklist row, told apart from an Artist entry by its position. */
const isRow = (value: unknown): value is { discNumber: number; trackNumber: number; title: string } => Boolean(value) && typeof value === 'object' && 'trackNumber' in (value as object);
/** Entries as their byline (or —), expected rows as "disc.track title" joined by " · ", a label as its name, else reviewValueText. */
export const lookupValueText = (value: unknown): string => Array.isArray(value)
  ? (value.length > 0 && value.every(isRow) ? value.map(row => `${row.discNumber}.${row.trackNumber} ${row.title}`).join(' · ') : entriesByline(value) || '—')
  : value && typeof value === 'object' && 'name' in value ? String(value.name) : reviewValueText(value);
/** Names with their MusicBrainz IDs, for a conflict that differs only in IDs (Artist entries or a label). */
export const lookupIdText = (value: unknown): string => (Array.isArray(value) ? value : value ? [value] : []).map(entry => `${String((entry as { name?: unknown }).name ?? '')} · ${String((entry as { musicBrainzId?: unknown }).musicBrainzId ?? '—')}`).join('; ') || '—';
