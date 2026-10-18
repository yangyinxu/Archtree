import type { ImportArtistEntry, ImportDraftV2 } from './adminApi';

/** One field-patch change: the value path, the saved value the edit started from, and the value replacing it whole. */
export type ImportDraftChange = { path: string; base: unknown; value: unknown };

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
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

/** The value a draft holds at a field-patch path, or undefined for a path it lacks. */
export function valueAt(draft: ImportDraftV2, path: string): unknown {
  const [scope, first, second] = path.split('.');
  if (scope === 'album') return (draft.album as Record<string, unknown>)[first];
  return (draft.tracks.find(track => track.slotId === first) as Record<string, unknown> | undefined)?.[second];
}
/** Applies changes the way the server writes them: each path's value replaces it whole, and every other value is kept. */
export function applyChanges(draft: ImportDraftV2, changes: readonly ImportDraftChange[]): ImportDraftV2 {
  return changes.reduce<ImportDraftV2>((next, { path, value }) => {
    const [scope, first, second] = path.split('.');
    return scope === 'album' ? { ...next, album: { ...next.album, [first]: value } }
      : { ...next, tracks: next.tracks.map(track => track.slotId === first ? { ...track, [second]: value } : track) };
  }, draft);
}
/**
 * Moves unsaved edits onto a newer saved draft, path by path: while every edited path still holds there the value the edit
 * started from or the edited value itself, saves of other paths (another administrator's, an upload confirmation) never block
 * this editor. Returns null when another save changed an edited path, so the editor offers the saved version instead.
 */
export function rebaseDraft(base: ImportDraftV2, draft: ImportDraftV2, saved: ImportDraftV2): ImportDraftV2 | null {
  const local = draftChanges(base, draft);
  if (!local.every(change => { const current = valueAt(saved, change.path); return same(current, change.base) || same(current, change.value); })) return null;
  return applyChanges(saved, local);
}

/** Entry names joined by each entry's join phrase, or a comma without one; the last entry's phrase connects to nothing. */
export const entriesByline = (entries: readonly Pick<ImportArtistEntry, 'name' | 'joinPhrase'>[]) =>
  entries.map((entry, index) => index === entries.length - 1 ? entry.name : `${entry.name}${entry.joinPhrase ?? ', '}`).join('');
export const artistByline = (draft: ImportDraftV2) => entriesByline(draft.album.artists);

/** The Artist name input edits a draft's single Artist entry, keeping its key and role; several entries show their byline read-only (S6c edits them). */
export const primaryArtistField = (draft: ImportDraftV2) => ({ value: draft.album.artists.length > 1 ? artistByline(draft) : draft.album.artists[0]?.name ?? '', editable: draft.album.artists.length <= 1 });

const fold = (value: string) => value.normalize('NFC').trim().toLowerCase();
/**
 * Applies a typed Artist name to a draft's single Artist entry: an empty value removes the entry; a rename keeps its key, role
 * and phrase, and its MusicBrainz ID only while the name still matches case-insensitively. Once cleared, typing again brings back
 * `saved` (the saved draft's single entry), so retyping the saved name changes nothing and keeps its Artist decision; only a
 * draft saved without an entry gets a new primary entry.
 */
export function withPrimaryArtistName(draft: ImportDraftV2, value: string, saved?: ImportArtistEntry): ImportDraftV2 {
  const [entry, ...others] = draft.album.artists;
  if (others.length) return draft;
  const kept = entry ?? saved;
  const idFrom = (source?: ImportArtistEntry) => source && source.key === kept?.key && fold(value) === fold(source.name) ? source.musicBrainzId : null;
  const artists: ImportArtistEntry[] = !value.trim() ? []
    : kept ? [{ ...kept, name: value, musicBrainzId: idFrom(saved) ?? idFrom(kept) }]
      : [{ key: crypto.randomUUID(), name: value, role: 'primary', joinPhrase: null, musicBrainzId: null }];
  return { ...draft, album: { ...draft.album, artists } };
}
