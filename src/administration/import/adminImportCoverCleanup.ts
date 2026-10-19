/**
 * Automatic cover cleanup once an import completes (owner rules: docs/business-rules.md, Administrator Album Imports, cover
 * bullet). Each automatically staged candidate that is neither the published cover, an explicit choice, nor pinned by an
 * existing-catalog cover operation is cleaned through the ordinary staged cleanup lifecycle:
 * - Reservation is a system lifecycle step with no role fence: it writes intent only (`deleting` with a cleanup `recovery`
 *   naming the publisher) under a UUID derived from the candidate version, receipted in `automaticReceipts`, never in ordinary or
 *   recovery receipts, and deletes nothing.
 * - Each storage step then runs under the publisher's fresh administrator check, exactly as cleanupAdminImportAsset deletes. A
 *   failure, including the publisher losing the role, leaves `cleanupFailed` (needs attention), which any current administrator
 *   retries with the original intent through `DELETE /imports/:id/assets/:slotId`; nothing retries it automatically.
 * - A candidate whose transfer may still land waits for it to settle; a pinned one is kept, releasing the pin re-arms this, and
 *   the sweep checks it again a day later in case a release that never re-arms released it.
 * The publication worker runs a pass right after a commit and sweeps completed imports whose `media.coverCleanup` is not done on
 * ticks that published nothing (crash recovery and imports completed before automatic covers, with their per-file duplicates).
 */
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getDatabaseClient } from '../../infrastructure/database';
import { checkAdminWorker } from '../adminWorkerLifecycle';
import { importEnabled, objectId } from './adminImportContract';
import { importCollection, importDigest, importPurposeFilter } from './adminImportService';
import { defaultImportObjectStorage, deleteReservedImportAsset, type ImportObjectStorage } from './adminImportStorage';
import { automaticCoverCleanupCandidates, automaticCoverCleanupOperationId, isAutomaticCoverSlot } from './adminImportCoverAutomation';
import { importPrivateStorageReady, importPublicationSupported } from './adminImportMediaTypes';
import { writableDraftFilter } from './adminImportDraftCompat';

const LEASE_MS = 300_000, UNSUPPORTED_RETRY_MS = 24 * 3600_000;

/**
 * One pass over one completed import (`onlyId`, or the oldest one the sweep may claim): reserve, delete, then mark the cleanup
 * done or waiting until the next candidate settles. Never throws; a stopped or failed pass keeps its lease until it expires and the
 * next pass resumes the same intents. Returns whether an import was claimed. `now` is the pass's clock (tests move it forward).
 */
export async function runAutomaticImportCoverCleanupOnce(storage: ImportObjectStorage = defaultImportObjectStorage, onlyId?: string, signal?: AbortSignal, now = new Date()): Promise<boolean> {
    let claimed = false;
    try {
        if (signal?.aborted || (onlyId !== undefined && !objectId(onlyId))) return false;
        if (!onlyId && (!importEnabled() || !importPrivateStorageReady())) return false;
        const worker = randomUUID(), started = Date.now(), at = () => new Date(now.getTime() + Date.now() - started), leased = { 'media.coverCleanup.leaseOwner': worker };
        const renewal = () => ({ $set: { 'media.coverCleanup.leaseUntil': new Date(at().getTime() + LEASE_MS) } });
        // A project saved in a newer draft format is read-only here, and its own release cleans it.
        const claim = await importCollection().findOneAndUpdate({ ...importPurposeFilter, ...writableDraftFilter, ...(onlyId ? { _id: new ObjectId(onlyId) } : {}),
            'media.publication.state': 'complete', 'media.coverCleanup.state': { $ne: 'done' },
            $or: [{ 'media.coverCleanup.leaseUntil': null }, { 'media.coverCleanup.leaseUntil': { $lte: now } }] },
        { $set: { 'media.coverCleanup.state': 'pending', 'media.coverCleanup.leaseOwner': worker, 'media.coverCleanup.leaseUntil': new Date(now.getTime() + LEASE_MS) } },
        { sort: { createdAt: 1 }, returnDocument: 'after' });
        const doc = claim.value; if (!doc?.media?.publication) return false;
        claimed = true; const _id = doc._id, id = _id.toHexString();
        if (!importPublicationSupported(doc.media.publication)) {
            // An approval this release cannot read is never cleaned here; the sweep looks again a day later.
            await importCollection().updateOne({ _id, ...leased }, { $set: { 'media.coverCleanup.leaseOwner': null, 'media.coverCleanup.leaseUntil': new Date(now.getTime() + UNSUPPORTED_RETRY_MS) } });
            return true;
        }
        const plan: { waitUntil: Date | null } = { waitUntil: null };
        const session = getDatabaseClient().startSession();
        try {
            await session.withTransaction(async () => {
                const current = await importCollection().findOne({ _id, ...leased }, { session }); if (!current?.media?.publication) throw new Error('Cover cleanup lease lost');
                const observed = current.revision, actorId = current.media.publication.actorId, planned = automaticCoverCleanupCandidates(current, at());
                const receipts = [...current.receipts, ...(current.recoveryReceipts ?? []), ...(current.automaticReceipts ?? [])]; let reserved = false;
                plan.waitUntil = planned.waitUntil;
                for (const asset of planned.reserve) {
                    const operationId = automaticCoverCleanupOperationId(asset);
                    // A UUID another intent already holds is never reused.
                    if (receipts.some(receipt => receipt.operationId === operationId)) continue;
                    asset.state = 'deleting'; asset.updatedAt = at(); asset.recovery = { operationId, expectedRevision: observed, kind: 'cleanup', actorId };
                    // The body cleanupAdminImportAsset fingerprints ({...intent, slotId}), so an administrator's retry replays it.
                    (current.automaticReceipts ??= []).push({ operationId, kind: 'cleanup', revision: observed + 1, actorId, at: at(),
                        hash: importDigest({ kind: 'cleanup', body: { operationId, expectedRevision: observed, slotId: asset.slotId } }) });
                    reserved = true;
                }
                if (reserved) { current.revision = observed + 1; current.updatedAt = at(); }
                current.media.coverCleanup = { state: 'pending', leaseOwner: worker, leaseUntil: new Date(at().getTime() + LEASE_MS) };
                const result = await importCollection().replaceOne({ _id, revision: observed, ...leased }, current, { session });
                if (result.matchedCount !== 1) throw new Error('Cover cleanup lease lost');
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
        } finally { await session.endSession(); }
        // Every automatic reservation still deleting, including one an earlier pass left, is deleted with its own intent.
        const reservedDoc = await importCollection().findOne({ _id, ...leased });
        const pending = (reservedDoc?.media?.assets ?? []).filter(asset => isAutomaticCoverSlot(asset.slotId) && asset.state === 'deleting'
            && asset.recovery?.kind === 'cleanup' && asset.recovery.operationId === automaticCoverCleanupOperationId(asset));
        for (const asset of pending) {
            checkAdminWorker(signal);
            if (!(await importCollection().updateOne({ _id, ...leased }, renewal())).matchedCount) return true;
            await deleteReservedImportAsset(asset.recovery.actorId, id, asset, asset.recovery.operationId, storage);
        }
        await importCollection().updateOne({ _id, ...leased }, { $set: { 'media.coverCleanup.state': plan.waitUntil ? 'pending' : 'done', 'media.coverCleanup.leaseOwner': null, 'media.coverCleanup.leaseUntil': plan.waitUntil } });
    } catch { /* The lease expires and the next pass resumes the same intents. */ }
    return claimed;
}
