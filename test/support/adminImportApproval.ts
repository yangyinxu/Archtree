import { randomUUID } from 'node:crypto';
import type { AdminImportDetailV2 } from '../../src/administration/import/adminImportContract';
import type { ImportDraftV2 } from '../../src/administration/import/adminImportDraft';
import { getAdminImport } from '../../src/administration/import/adminImportService';
import { publishAdminImport } from '../../src/administration/import/adminImportPublisher';
import { draftChanges } from './adminImportDraftChanges';

/**
 * What an approval overrides from the shown project: an unsaved edit of its draft and any of the body's own fields.
 * `musicBrainzIds: 'created'` lists every MusicBrainz ID the edited draft carries as recorded on a new record (none for an append).
 */
export type ApprovalOptions = { edit?: (draft: ImportDraftV2) => void; decisions?: unknown[]; selectedCoverSlotId?: string | null; approvalDigest?: string; operationId?: string; expectedRevision?: number; preselections?: unknown[];
    suggestionTicks?: { generation: number; ticked: string[]; unticked: string[] }; musicBrainzIds?: unknown[] | 'created' };

/** The ID writes a confirmation lists when every Artist entry and the label carrying a MusicBrainz ID becomes a new record. */
export const createdMusicBrainzIdWrites = (draft: ImportDraftV2) => [
    ...draft.album.artists.filter(entry => entry.musicBrainzId).map(entry => ({ scope: 'artist', entryKey: entry.key, musicBrainzId: entry.musicBrainzId, replaces: null })),
    ...(draft.album.label?.musicBrainzId ? [{ scope: 'label', entryKey: null, musicBrainzId: draft.album.label.musicBrainzId, replaces: null }] : [])];

/**
 * A one-step approval body as the Web confirmation sends it for a shown project: its revision, the changes of an unsaved edit
 * (none by default), its saved decisions and cover, and its approvalDigest. The optional `preselections`, Luna
 * `suggestionTicks` and MusicBrainz ID writes the confirmation showed are sent only when given. A replay must reuse the same object.
 */
export function approvalBody(item: Pick<AdminImportDetailV2, 'revision' | 'draft' | 'decisions' | 'selectedCoverSlotId' | 'approvalDigest'>, options: ApprovalOptions = {}) {
    const edited = structuredClone(item.draft); options.edit?.(edited);
    const decisions = options.decisions ?? item.decisions;
    const append = decisions.some(decision => (decision as { scope?: unknown } | null)?.scope === 'album' && (decision as { action?: unknown }).action === 'reuse');
    const musicBrainzIds = options.musicBrainzIds === 'created' ? (append ? [] : createdMusicBrainzIdWrites(edited)) : options.musicBrainzIds;
    return {
        operationId: options.operationId ?? randomUUID(), expectedRevision: options.expectedRevision ?? item.revision, changes: draftChanges(item.draft, edited),
        decisions, selectedCoverSlotId: options.selectedCoverSlotId !== undefined ? options.selectedCoverSlotId : item.selectedCoverSlotId,
        approvalDigest: options.approvalDigest ?? item.approvalDigest, ...(options.preselections ? { preselections: options.preselections } : {}),
        ...(options.suggestionTicks ? { suggestionTicks: options.suggestionTicks } : {}), ...(musicBrainzIds ? { musicBrainzIds } : {})
    };
}

/** Reads the project as the administrator's editor shows it, then approves exactly that. */
export async function approveImport(actor: string, id: string, options: ApprovalOptions = {}) {
    return publishAdminImport(actor, id, approvalBody((await getAdminImport(actor, id)).item, options));
}
