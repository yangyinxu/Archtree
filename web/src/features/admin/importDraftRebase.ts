import type { ImportDraftV2 } from './adminApi';
import { draftChanges, same, type ImportDraftChange } from './importDraftPatch';

/*
 * Rebasing unsaved Draft v2 edits onto a newer saved draft. The import page loads this module beside the editor, never in its
 * initial JavaScript: only an editor that has loaded can hold unsaved edits.
 */

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

type IdItem = { key?: string; name: string; musicBrainzId: string | null } | null;
/** The Artist entries or the label at a path (none for any other path). */
const idItems = (path: string, value: unknown) => (path === 'album.label' ? [value] : path === 'album.artists' ? value : []) as IdItem[];
const noIds = (value: unknown) => JSON.stringify(value, (key, item) => key === 'musicBrainzId' ? undefined : item);
const fold = (name: string) => name.normalize('NFC').toLowerCase();
/**
 * An edited Artist entry list or label with the saved MusicBrainz IDs that metadata lookup added, removed or replaced since `base`:
 * an entry (by key) or the label whose ID the edit left as it started takes the saved one, kept only under an unchanged name
 * compared case-insensitively, as the server merges them. An ID the edit cleared stays cleared.
 */
function withSavedIds(path: string, base: unknown, saved: unknown, value: unknown): unknown {
  const merged = idItems(path, value).map(entry => {
    const from = idItems(path, base).find(item => item && item.key === entry?.key), to = idItems(path, saved).find(item => item && item.key === entry?.key);
    return entry && from && to && entry.musicBrainzId === from.musicBrainzId && to.musicBrainzId !== from.musicBrainzId
      ? { ...entry, musicBrainzId: fold(to.name) === fold(entry.name) ? to.musicBrainzId : null } : entry;
  });
  return path === 'album.label' ? merged[0] : path === 'album.artists' ? merged : value;
}
/**
 * Moves unsaved edits onto a newer saved draft, path by path: while every edited path still holds there the value the edit
 * started from or the edited value itself, saves of other paths (another administrator's, an upload confirmation) never block
 * this editor. An edited path whose saved value is `automatic` (written from file tags or metadata lookup) is carried over too, and
 * so are Artist entries or a label that differ from the start only in MusicBrainz IDs (which metadata lookup adds and removes on
 * the administrator's own values), each taking the saved IDs (withSavedIds), because an administrator save always wins over
 * automation. Returns null when another administrator's save changed an edited path, so the editor offers the saved version
 * instead.
 */
export function rebaseDraft(base: ImportDraftV2, draft: ImportDraftV2, saved: ImportDraftV2, automatic: ReadonlySet<string> = new Set()): ImportDraftV2 | null {
  const local = draftChanges(base, draft);
  if (!local.every(change => { const current = valueAt(saved, change.path); return automatic.has(change.path) || same(current, change.base) || same(current, change.value)
    || (idItems(change.path, current).length > 0 && noIds(current) === noIds(change.base)); })) return null;
  return applyChanges(saved, local.map(change => ({ ...change, value: withSavedIds(change.path, change.base, valueAt(saved, change.path), change.value) })));
}
