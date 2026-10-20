import { randomUUID } from 'node:crypto';
import { editAdminImport } from '../../src/administration/import/adminImportService';
import type { ImportArtistEntry, ImportDraftV2 } from '../../src/administration/import/adminImportDraft';

/** One primary Artist entry with a fresh key, as the Web editor creates it from a typed name. */
export const artistEntries = (name: string, key: string = randomUUID()): ImportArtistEntry[] => name ? [{ key, name, role: 'primary', joinPhrase: null, musicBrainzId: null }] : [];

/**
 * Decision body items as the Web editor sends them: an Artist decision names the draft's first entry (or `entryKey` when it
 * already names one) and that entry's name, a label decision the label's name, and every other scope names neither.
 */
export const withEntryKeys = <T extends { scope: string; entryKey?: string | null }>(draft: ImportDraftV2, decisions: readonly T[]) =>
    decisions.map(decision => {
        const entryKey = decision.scope === 'artist' ? decision.entryKey ?? draft.album.artists[0]?.key ?? null : null;
        const boundName = decision.scope === 'artist' ? draft.album.artists.find(entry => entry.key === entryKey)?.name ?? null : decision.scope === 'label' ? draft.album.label?.name ?? null : null;
        return { ...decision, entryKey, boundName };
    });

/** The field-patch changes from a saved draft to an edited one: album paths, then tracks in saved order, changed values only. */
export function draftChanges(base: ImportDraftV2, draft: ImportDraftV2) {
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right), changes: { path: string; base: unknown; value: unknown }[] = [];
    for (const field of ['title', 'artists', 'label', 'releaseDate', 'visibility'] as const) if (!same(base.album[field], draft.album[field])) changes.push({ path: `album.${field}`, base: base.album[field], value: draft.album[field] });
    for (const saved of base.tracks) {
        const track = draft.tracks.find(item => item.slotId === saved.slotId)!;
        for (const field of ['title', 'discNumber', 'trackNumber'] as const) if (!same(saved[field], track[field])) changes.push({ path: `tracks.${saved.slotId}.${field}`, base: saved[field], value: track[field] });
    }
    return changes;
}

/**
 * Saves an edit of a project's current Draft v2 the way the Web editor does. Without a change it sends a no-op Album title
 * change, so receipt and allowance loops still admit one ordinary edit each.
 */
export function editImportDraft(actor: string, id: string, item: { revision: number; draft: ImportDraftV2 }, edit: (draft: ImportDraftV2) => void = () => undefined, operationId: string = randomUUID()) {
    const draft = structuredClone(item.draft); edit(draft);
    const changes = draftChanges(item.draft, draft);
    return editAdminImport(actor, id, { operationId, expectedRevision: item.revision, changes: changes.length ? changes : [{ path: 'album.title', base: item.draft.album.title, value: item.draft.album.title }] });
}
