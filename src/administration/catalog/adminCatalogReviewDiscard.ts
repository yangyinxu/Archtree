/**
 * Discards an unapplied existing-Album review (owner rules: docs/business-rules.md, Catalog Visibility and Administration). One
 * transaction replaces the review with a tombstone at the same ID and deletes its metadata lookup record. A review stages no media
 * or artwork and writes the catalog only when applied, so nothing else holds its data. A lookup step or Luna call in flight then
 * finds neither its record nor an analysis and stores nothing. This module never loads the review service, the lookup service or
 * the review lookup requests.
 */
import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../../infrastructure/database';
import { AdminImportError, objectId } from '../import/adminImportContract';
import { importCollection, importDigest, parseAdminProjectMutation, withImportAdmin, type AdminImportDocument } from '../import/adminImportService';
import { catalogReviewSourceView, importDraftWritable } from '../import/adminImportDraftCompat';
import { ADMIN_IMPORT_LOOKUP_COLLECTION } from '../lookup/lookupContract';
import type { CatalogReviewDiscardResponse, CatalogReviewTombstone, CatalogReviewTombstoneReceipt, DiscardCatalogReview } from './adminCatalogReviewContract';

const fail = (status: number, code: string): never => { throw new AdminImportError(status, code); };
const discardedPurpose = 'catalogReviewDiscarded' as const;
const tombstones = () => getDb()!.collection<CatalogReviewTombstone>('adminAlbumImports');

/** The tombstone of a discarded review at `id`, read in the caller's transaction; a review creation's replay reads it too. */
export const readCatalogReviewTombstone = (id: ObjectId, session: ClientSession): Promise<CatalogReviewTombstone | null> =>
    tombstones().findOne({ _id: id, purpose: discardedPurpose }, { session });

/**
 * Whether `id` names a discarded review: one bounded `_id` read outside any transaction, so the routes can report a review discarded
 * meanwhile. False for anything else, and on any failure (it never throws).
 */
export async function catalogReviewDiscarded(id: string): Promise<boolean> {
    if (!objectId(id)) return false;
    try { return Boolean(await tombstones().findOne({ _id: new ObjectId(id), purpose: discardedPurpose }, { projection: { _id: 1 }, maxTimeMS: 1_000 })); }
    catch { return false; }
}

/**
 * Refuses a discard of `doc`, in this order: an applied review whatever `expectedRevision` says (applying is terminal), an operation
 * ID any receipt of the review used, a newer draft format, a revision before the last administrator receipt or beyond the current
 * one, then Luna queued or running. Luna ticks and lookup writes add no receipt, so they never make it stale. A stopped Luna call
 * still settling, any source status and a review at its receipt limit are admitted: a discard is never counted against it. Pure.
 */
export function assertCatalogReviewDiscardable(doc: AdminImportDocument, body: DiscardCatalogReview): void {
    if (doc.catalogApplied) fail(409, 'ADMIN_CATALOG_REVIEW_APPLIED');
    if ([...doc.receipts, ...(doc.recoveryReceipts ?? []), ...(doc.automaticReceipts ?? [])].some(receipt => receipt.operationId === body.operationId)) fail(409, 'ADMIN_IMPORT_OPERATION_CONFLICT');
    if (!importDraftWritable(doc)) fail(409, 'ADMIN_IMPORT_RELOAD_REQUIRED');
    // The floor every review change has: its last administrator receipt (reviews hold no recovery receipts).
    if (body.expectedRevision < (doc.receipts[doc.receipts.length - 1]?.revision ?? doc.revision) || body.expectedRevision > doc.revision) fail(409, 'ADMIN_IMPORT_REVISION_CONFLICT');
    if (doc.analysis && ['queued', 'running'].includes(doc.analysis.state)) fail(409, 'ADMIN_IMPORT_ANALYSIS_ACTIVE');
}

/**
 * The tombstone that replaces `doc` once `receipt` discards it: exactly the keys of CatalogReviewTombstone, with the review's
 * creation receipt (without its selection) and `receipt`. No draft, capture, title, filename, analysis or lookup data survives. Pure.
 */
export function catalogReviewTombstone(doc: AdminImportDocument, receipt: CatalogReviewTombstoneReceipt): CatalogReviewTombstone {
    const create = doc.receipts.find(value => value.kind === 'create');
    const created: CatalogReviewTombstoneReceipt[] = create
        ? [{ operationId: create.operationId, kind: 'create', revision: create.revision, actorId: create.actorId, hash: create.hash, at: create.at }] : [];
    return { _id: doc._id, purpose: discardedPurpose, actorId: doc.actorId, createdAt: doc.createdAt, updatedAt: receipt.at, revision: receipt.revision,
        albumId: catalogReviewSourceView(doc.catalogSource).album.id, discardedAt: receipt.at, discardedBy: receipt.actorId, receipts: [...created, receipt] };
}

/** The discard's answer, from the tombstone's discard receipt. */
function responseOf(tombstone: CatalogReviewTombstone): CatalogReviewDiscardResponse {
    const { operationId, revision } = tombstone.receipts.find(receipt => receipt.kind === 'discard')!;
    return { discarded: { id: tombstone._id.toHexString(), albumId: tombstone.albumId }, receipt: { operationId, kind: 'discard', revision } };
}

/**
 * POST /catalog-reviews/:id/discard: exactly `{operationId, expectedRevision}`, validated before any database access. Inside
 * withImportAdmin (which rechecks the administrator), a tombstone answers its original intent (operation ID, body and
 * administrator) with the original answer and anything else with 404 ADMIN_CATALOG_REVIEW_DISCARDED; an unknown review is 404
 * ADMIN_CATALOG_REVIEW_NOT_FOUND; then assertCatalogReviewDiscardable decides. The review becomes its tombstone, guarded by the
 * revision read, and its lookup record is deleted in the same transaction, so either both happen or nothing is written.
 */
export async function discardCatalogReview(actor: string, id: string, raw: unknown): Promise<CatalogReviewDiscardResponse> {
    const body: DiscardCatalogReview = parseAdminProjectMutation(raw, []);
    if (!objectId(id)) return fail(404, 'ADMIN_CATALOG_REVIEW_NOT_FOUND');
    const _id = new ObjectId(id), hash = importDigest({ kind: 'discard', body });
    return withImportAdmin(actor, async session => {
        const tombstone = await readCatalogReviewTombstone(_id, session);
        if (tombstone) {
            const prior = tombstone.receipts.find(receipt => receipt.kind === 'discard');
            return prior && prior.operationId === body.operationId && prior.hash === hash && prior.actorId === actor ? responseOf(tombstone) : fail(404, 'ADMIN_CATALOG_REVIEW_DISCARDED');
        }
        const doc = await importCollection().findOne({ _id, purpose: 'catalogReview' }, { session });
        if (!doc) return fail(404, 'ADMIN_CATALOG_REVIEW_NOT_FOUND');
        assertCatalogReviewDiscardable(doc, body);
        const receipt: CatalogReviewTombstoneReceipt = { operationId: body.operationId, kind: 'discard', revision: doc.revision + 1, actorId: actor, hash, at: new Date() };
        const next = catalogReviewTombstone(doc, receipt);
        // An untyped handle, since the filter names the review's purpose and the replacement the tombstone's. A concurrent writer is
        // a transaction write conflict, which withTransaction retries against fresh state.
        const replaced = await getDb()!.collection('adminAlbumImports').replaceOne({ _id, purpose: 'catalogReview', revision: doc.revision }, next, { session });
        if (replaced.matchedCount !== 1) return fail(409, 'ADMIN_IMPORT_REVISION_CONFLICT');
        // The run ends with the review: a queued or retrying run is never claimed again, and a step in flight finds no record.
        await getDb()!.collection(ADMIN_IMPORT_LOOKUP_COLLECTION).deleteOne({ _id }, { session });
        return responseOf(next);
    });
}
