import { randomUUID } from 'node:crypto';
import type { AdminImportDetailV2 } from '../../src/administration/import/adminImportContract';
import type { ImportDraftV2 } from '../../src/administration/import/adminImportDraft';
import { getAdminImport } from '../../src/administration/import/adminImportService';
import { publishAdminImport } from '../../src/administration/import/adminImportPublisher';
import { draftChanges } from './adminImportDraftChanges';

/** What an approval overrides from the shown project: an unsaved edit of its draft and any of the body's own fields. */
export type ApprovalOptions = { edit?: (draft: ImportDraftV2) => void; decisions?: unknown[]; selectedCoverSlotId?: string | null; approvalDigest?: string; operationId?: string; expectedRevision?: number; preselections?: unknown[] };

/**
 * A one-step approval body as the Web confirmation sends it for a shown project: its revision, the changes of an unsaved edit
 * (none by default), its saved decisions and cover, and its approvalDigest. The optional `preselections` the confirmation showed
 * are sent only when given. A replay must reuse the same object.
 */
export function approvalBody(item: Pick<AdminImportDetailV2, 'revision' | 'draft' | 'decisions' | 'selectedCoverSlotId' | 'approvalDigest'>, options: ApprovalOptions = {}) {
    const edited = structuredClone(item.draft); options.edit?.(edited);
    return {
        operationId: options.operationId ?? randomUUID(), expectedRevision: options.expectedRevision ?? item.revision, changes: draftChanges(item.draft, edited),
        decisions: options.decisions ?? item.decisions, selectedCoverSlotId: options.selectedCoverSlotId !== undefined ? options.selectedCoverSlotId : item.selectedCoverSlotId,
        approvalDigest: options.approvalDigest ?? item.approvalDigest, ...(options.preselections ? { preselections: options.preselections } : {})
    };
}

/** Reads the project as the administrator's editor shows it, then approves exactly that. */
export async function approveImport(actor: string, id: string, options: ApprovalOptions = {}) {
    return publishAdminImport(actor, id, approvalBody((await getAdminImport(actor, id)).item, options));
}
