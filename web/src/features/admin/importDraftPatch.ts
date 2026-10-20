import type { ImportArtistEntry, ImportDraftV2 } from './adminApi';

/** One field-patch change: the value path, the saved value the edit started from, and the value replacing it whole. */
export type ImportDraftChange = { path: string; base: unknown; value: unknown };

export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const albumFields = ['title', 'artists', 'label', 'releaseDate', 'visibility'] as const;
const trackFields = ['title', 'discNumber', 'trackNumber'] as const;

/**
 * The changes a save sends: only the values that differ from the saved draft, in a fixed order (album values, then each track in
 * saved order). Each base is the saved value, so the server refuses the save only if another administrator changed that path.
 */
export function draftChanges(base: ImportDraftV2, draft: ImportDraftV2): ImportDraftChange[] {
  const changes: ImportDraftChange[] = [];
  for (const field of albumFields) if (!same(base.album[field], draft.album[field])) changes.push({ path: `album.${field}`, base: base.album[field], value: draft.album[field] });
  for (const saved of base.tracks) {
    const track = draft.tracks.find(item => item.slotId === saved.slotId); if (!track) continue;
    for (const field of trackFields) if (!same(saved[field], track[field])) changes.push({ path: `tracks.${saved.slotId}.${field}`, base: saved[field], value: track[field] });
  }
  return changes;
}

/** Entry names joined by each entry's join phrase, or a comma without one; the last entry's phrase connects to nothing. */
export const entriesByline = (entries: readonly Pick<ImportArtistEntry, 'name' | 'joinPhrase'>[]) =>
  entries.map((entry, index) => index === entries.length - 1 ? entry.name : `${entry.name}${entry.joinPhrase ?? ', '}`).join('');
export const artistByline = (draft: ImportDraftV2) => entriesByline(draft.album.artists);
