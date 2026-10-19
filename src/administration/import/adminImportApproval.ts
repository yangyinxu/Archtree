/**
 * One-step approval: a publish body carries the confirmation's unsaved draft changes, its identity decisions, its cover choice and
 * the approvalDigest of the saved project it was built on. Saving them shares the publish transaction with freezing, so a refusal
 * leaves the saved draft as it was. Owner rules: docs/business-rules.md (Administrator Album Imports).
 */
import type { ClientSession } from 'mongodb';
import { AdminImportError, IMPORT_APPROVAL_FIELDS, invalidImport } from './adminImportContract';
import { DRAFT_V2_LIMITS, hasOwn, retainBoundDecisions, type ImportDraftV2 } from './adminImportDraft';
import { importDraftV2View } from './adminImportDraftCompat';
import { importCoverSelectable } from './adminImportMediaTypes';
import { adminImportDetail, parseImportDecisions, reusesOneArtistTwice, type AdminImportDocument } from './adminImportService';
import { shownPreselectionKey } from './adminImportIdentity';
import { applyAdministratorChanges, boundDraftChanges, boundedJson, draftWithinSizeLimit, parseDraftChanges, storedDraftV2 } from './adminImportValueState';

/**
 * Bounds a publish body's approval fields before its intent is fingerprinted: changes as a field save bounds them (none allowed),
 * decisions as /decisions bounds them (at most 122 flat records of at most 1 KB, two entries never reusing one Artist), a cover
 * slot and a digest of at most 64 characters, and the optional shown `preselections` as at most 122 well-formed preselections
 * (shownPreselectionKey). A body that predates one-step approval has none of them and passes; every body this release admits
 * passes, so a lost-response replay is never refused.
 */
export function boundImportApproval(body: Record<string, unknown>): void {
    if (hasOwn(body, 'changes')) boundDraftChanges(body.changes, 0);
    if (hasOwn(body, 'decisions') && (!Array.isArray(body.decisions) || body.decisions.length > DRAFT_V2_LIMITS.decisions
        || body.decisions.some(item => !boundedJson(item, 1, 1_000)) || reusesOneArtistTwice(body.decisions))) invalidImport();
    if (hasOwn(body, 'selectedCoverSlotId') && body.selectedCoverSlotId !== null && (typeof body.selectedCoverSlotId !== 'string' || body.selectedCoverSlotId.length > 64)) invalidImport();
    if (hasOwn(body, 'approvalDigest') && (typeof body.approvalDigest !== 'string' || body.approvalDigest.length > 64)) invalidImport();
    if (hasOwn(body, 'preselections') && (!Array.isArray(body.preselections) || body.preselections.length > DRAFT_V2_LIMITS.decisions
        || body.preselections.some(item => !boundedJson(item, 1, 1_000) || shownPreselectionKey(item) === null))) invalidImport();
}

/**
 * Inside the publish transaction, after receipt lookup: requires every approval field, refuses a changed saved basis (409
 * ADMIN_IMPORT_APPROVAL_STALE), then saves decisions, changes and the cover exactly as /decisions, PATCH and /select-cover would,
 * in that order. Decisions carry the bound names shown, which must still be the saved names (409 ADMIN_IMPORT_DECISION_STALE), and
 * renaming an entry or the label in the same approval drops its decision. Returns the saved Draft v2; any refusal aborts the
 * transaction with nothing written.
 */
export async function saveImportApproval(doc: AdminImportDocument, body: Record<string, unknown>, actor: string, session: ClientSession): Promise<ImportDraftV2> {
    if (!IMPORT_APPROVAL_FIELDS.every(key => hasOwn(body, key)) || !Array.isArray(body.changes) || !Array.isArray(body.decisions)
        || typeof body.approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.approvalDigest)) return invalidImport();
    // The shown basis is the projection GET returned, read after any format-1 conversion admission performs (which keeps it).
    if (adminImportDetail(doc, actor).approvalDigest !== body.approvalDigest) throw new AdminImportError(409, 'ADMIN_IMPORT_APPROVAL_STALE');
    const draft = storedDraftV2(doc), before = structuredClone(draft);
    doc.decisions = await parseImportDecisions(doc, draft, body.decisions, session);
    if (body.changes.length) applyAdministratorChanges({ draft, draftOrigins: doc.draftOrigins ??= {} },
        parseDraftChanges(body.changes, doc.manifest, draft), importDraftV2View(draft, doc.manifest, doc._id.toHexString()));
    if (!draftWithinSizeLimit(before, draft)) invalidImport();
    doc.decisions = retainBoundDecisions(doc.decisions, draft);
    if (!importCoverSelectable(doc.media, body.selectedCoverSlotId)) throw new AdminImportError(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
    doc.media ??= { assets: [] }; doc.media.selectedCoverSlotId = body.selectedCoverSlotId;
    return draft;
}
