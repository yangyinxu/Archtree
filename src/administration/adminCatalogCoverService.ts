import { checkAdminWorker, startAdminWorker, type AdminWorkTracker } from './adminWorkerLifecycle';
import { randomUUID } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { isAdminCatalogEditingEnabled, isAdminVisibilityEditingEnabled } from '../services/adminCapabilityService';
import { deleteCoverArt, updateCoverArtOwnerAndCleanup, maxCoverArtInputBytes } from '../services/imageStorageService';
import { adminCatalogItemRevision, AdminCatalogError, adminCatalogSnapshot, readAdminCatalogRecord, withCurrentAdministrator, type AdminCatalogKind } from './adminCatalogService';
import { exact, objectId, record, uuid } from './adminImportContract';
import { importCollection, importDigest } from './adminImportService';
import { importPrivateStorageReady, type ImportAsset } from './adminImportMediaTypes';
import { defaultImportObjectStorage, importAssetTarget, type ImportObjectIdentity, type ImportObjectStorage, type ImportObjectTarget } from './adminImportStorage';

type CoverKind = Exclude<AdminCatalogKind, 'organization'>;
type CoverState = 'copying' | 'needsAttention' | 'complete' | 'cancelled';
type CoverOperation = {
    _id: ObjectId; actor: string; operationId: string; fingerprint: string; kind: CoverKind; ownerId: string;
    expectedRevision: string; previousImageId: string | null; sourceImportId: string | null; source: ImportAsset | null;
    imageId: string | null; target: ImportObjectTarget | null; identity: ImportObjectIdentity | null;
    stage: 'reserved' | 'sent' | 'stored' | 'attached'; state: CoverState; cleanupPending: boolean;
    createdAt: Date; updatedAt: Date; grantExpiresAt: Date; leaseOwner: string | null; leaseUntil: Date | null;
    cancellation?: { actor: string; operationId: string; fingerprint: string; expectedRevision: string | null };
};
export interface AdminCatalogCoverDependencies { storage?: ImportObjectStorage; cleanup?: (imageId: string, kind: CoverKind, ownerId: string) => Promise<void> }
const operations = () => getDb()!.collection<CoverOperation>('adminCatalogCoverOperations');
const terminalStates: CoverState[] = ['complete', 'cancelled'];
const unresolvedOperations = { $or: [{ state: { $nin: terminalStates } }, { cleanupPending: true }] };
const collections = { artist: 'artists', album: 'albums', audioTrack: 'audioTracks' };
const fail = (status: number, code: string): never => { throw new AdminCatalogError(status, code); };
const cleanupDefault = (imageId: string, kind: CoverKind, ownerId: string) => deleteCoverArt(imageId, { expectedOwnerType: kind, expectedOwnerId: ownerId });
const requireKind = (kind: AdminCatalogKind): CoverKind => kind === 'organization' ? fail(400, 'ADMIN_CATALOG_COVER_UNSUPPORTED') : kind;
const feature = () => { if (!isAdminCatalogEditingEnabled()) fail(503, 'ADMIN_CATALOG_EDITING_UNAVAILABLE'); };
const coverResult = (actor: string, op: CoverOperation, receiptId = op.operationId) => withCurrentAdministrator(actor, async session => {
    const owner = await readAdminCatalogRecord(op.kind, op.ownerId, session);
    if (!owner && op.state !== 'cancelled') fail(404, 'ADMIN_CATALOG_NOT_FOUND');
    return { item: owner ? await adminCatalogSnapshot(op.kind, owner, session) : null,
        receipt: { operationId: receiptId }, coverOperation: { state: op.state, cleanupPending: op.cleanupPending } };
});
const currentApproval = (op: CoverOperation) => {
    if (op.grantExpiresAt <= new Date()) fail(409, 'ADMIN_CATALOG_APPROVAL_EXPIRED');
};
const effectiveActor = (op: CoverOperation) => op.cancellation?.actor ?? op.actor;
async function releaseSourcePin(op: CoverOperation, session: ClientSession) {
    if (op.sourceImportId) await importCollection().updateOne({ _id: new ObjectId(op.sourceImportId),
        'media.assets': { $elemMatch: { operationId: op.source!.operationId, coverConsumers: op._id.toHexString() } } },
        { $pull: { 'media.assets.$.coverConsumers': op._id.toHexString() }, $inc: { revision: 1 } } as any, { session });
}

async function requireDelivery(kind: CoverKind, owner: any, session: ClientSession) {
    let hidden = owner.visibility !== undefined && owner.visibility !== 'public';
    if (kind === 'audioTrack' && owner.albumId) { const album = objectId(owner.albumId) ? await readAdminCatalogRecord('album', owner.albumId, session) : null; hidden ||= !album || (album.visibility !== undefined && album.visibility !== 'public'); }
    if (hidden && !isAdminVisibilityEditingEnabled()) fail(409, 'ADMIN_CATALOG_HIDDEN_DELIVERY_NOT_READY');
}

/** Exact approval and both old/new storage identities survive browser aborts and ambiguous S3/Mongo outcomes. */
async function mutateCover(actor: string, rawKind: AdminCatalogKind, ownerId: string, raw: unknown, clear: boolean, dependencies: AdminCatalogCoverDependencies) {
    const kind = requireKind(rawKind), body = record(raw); exact(body, ['operationId', 'expectedRevision', ...(clear ? [] : ['importId', 'slotId', 'expectedSourceRevision'])]);
    if (!objectId(ownerId) || !uuid(body.operationId) || typeof body.expectedRevision !== 'string' || !/^cr_[A-Za-z0-9_-]{43}$/.test(body.expectedRevision) || (!clear && (!Number.isSafeInteger(body.expectedSourceRevision) || Number(body.expectedSourceRevision) < 1 || !objectId(body.importId) || typeof body.slotId !== 'string' || body.slotId.length > 60))) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const operationId = body.operationId as string, fingerprint = importDigest({ kind, ownerId, clear, body });
    const operation = await withCurrentAdministrator(actor, async session => {
        const prior = await operations().findOne({ actor, operationId }, { session });
        if (prior) { if (prior.fingerprint !== fingerprint) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT'); return prior; }
        if (await operations().findOne({ 'cancellation.actor': actor, 'cancellation.operationId': operationId }, { session })) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
        feature(); if (!clear && (!importPrivateStorageReady() || !process.env.S3_BUCKET_NAME?.trim())) fail(503, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE');
        const owner = await readAdminCatalogRecord(kind, ownerId, session); if (!owner) return fail(404, 'ADMIN_CATALOG_NOT_FOUND');
        if (adminCatalogItemRevision(kind, owner) !== body.expectedRevision) fail(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        if (!clear) await requireDelivery(kind, owner, session);
        // Serialize competing approvals without changing the displayed metadata revision.
        await getDb()!.collection(collections[kind]).updateOne({ _id: owner._id }, { $inc: { coverAdmissionRevision: 1 } }, { session });
        if (await operations().findOne({ kind, ownerId, state: { $nin: terminalStates } }, { session, projection: { _id: 1 } })) fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
        if (await operations().countDocuments({ actor, ...unresolvedOperations }, { session, limit: 256 }) >= 256) fail(429, 'ADMIN_CATALOG_RECEIPT_LIMIT');
        const previousImageId = owner.coverArtId ? String(owner.coverArtId) : null;
        if (previousImageId) { const previous = objectId(previousImageId) && await getDb()!.collection('imageAssets').findOne({ _id: new ObjectId(previousImageId), ownerType: kind, ownerId, s3Key: `images/${previousImageId}` }, { session }); if (!previous || previous.uploadStatus !== 'ready') fail(409, 'ADMIN_CATALOG_COVER_EVIDENCE_REQUIRED'); }
        const _id = new ObjectId(), now = new Date(); let source: ImportAsset | null = null, sourceImportId: string | null = null;
        if (!clear) {
            const project = await importCollection().findOne({ _id: new ObjectId(body.importId as string) }, { session });
            if (!project || project.revision !== body.expectedSourceRevision) fail(409, 'ADMIN_CATALOG_COVER_SOURCE_CHANGED');
            source = project?.media?.assets.find(asset => asset.slotId === body.slotId && asset.state === 'ready' && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType)) ?? null;
            if (!source?.etag || source.byteLength > maxCoverArtInputBytes) fail(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
            sourceImportId = body.importId as string; source!.coverConsumers ??= []; source!.coverConsumers.push(_id.toHexString());
            await importCollection().replaceOne({ _id: project!._id, revision: project!.revision }, { ...project!, revision: project!.revision + 1, updatedAt: now }, { session });
        }
        const imageId = clear ? null : new ObjectId().toHexString();
        const op: CoverOperation = { _id, actor, operationId, fingerprint, kind, ownerId, expectedRevision: body.expectedRevision as string, previousImageId, sourceImportId, source: source ? structuredClone(source) : null, imageId, target: source ? { ...importAssetTarget(sourceImportId!, source), bucket: process.env.S3_BUCKET_NAME!.trim(), key: `images/${imageId}`, operationId } : null, identity: null, stage: clear ? 'stored' : 'reserved', state: 'copying', cleanupPending: false, createdAt: now, updatedAt: now, grantExpiresAt: new Date(Date.now() + 86_400_000), leaseOwner: null, leaseUntil: null };
        await operations().insertOne(op, { session }); return op;
    });
    await runAdminCatalogCoverOnce(dependencies, operation._id.toHexString());
    return coverResult(actor, (await operations().findOne({ _id: operation._id }))!);
}
export const replaceAdminCatalogCover = (actor: string, kind: AdminCatalogKind, id: string, body: unknown, dependencies: AdminCatalogCoverDependencies = {}) => mutateCover(actor, kind, id, body, false, dependencies);
export const clearAdminCatalogCover = (actor: string, kind: AdminCatalogKind, id: string, body: unknown, dependencies: AdminCatalogCoverDependencies = {}) => mutateCover(actor, kind, id, body, true, dependencies);

export const listAdminCatalogCoverOperations = (actor: string, rawKind: AdminCatalogKind, ownerId: string) => withCurrentAdministrator(actor, async session => {
    const kind = requireKind(rawKind); if (!objectId(ownerId)) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    // An unavailable owner must not hide its outstanding canonical-object cleanup evidence.
    // Old cleanup debt must remain visible even after many successful later replacements.
    const rows = await operations().find({ kind, ownerId, ...unresolvedOperations }, { session, maxTimeMS: 2000 }).sort({ createdAt: -1, _id: -1 }).limit(25).toArray();
    if (rows.length < 25) rows.push(...await operations().find({ kind, ownerId, state: { $in: terminalStates }, cleanupPending: false }, { session, maxTimeMS: 2000 }).sort({ createdAt: -1, _id: -1 }).limit(25 - rows.length).toArray());
    return { items: rows.map(op => ({ operationId: op.operationId, startedByMe: effectiveActor(op) === actor, state: op.state, cleanupPending: op.cleanupPending })) };
});

/** Cancellation is a new reviewed intent. It never rebases an expired approval or detaches an installed cover. */
export async function cancelAdminCatalogCover(actor: string, rawKind: AdminCatalogKind, ownerId: string,
    originalOperationId: string, raw: unknown, dependencies: AdminCatalogCoverDependencies = {}) {
    const kind = requireKind(rawKind), body = record(raw); exact(body, ['operationId', 'expectedRevision']);
    if (!objectId(ownerId) || !uuid(originalOperationId) || !uuid(body.operationId)
        || (body.expectedRevision !== null && (typeof body.expectedRevision !== 'string'
            || !/^cr_[A-Za-z0-9_-]{43}$/.test(body.expectedRevision)))) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const operationId = body.operationId as string;
    if (operationId === originalOperationId) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
    const fingerprint = importDigest({ kind, ownerId, originalOperationId, body });
    const op = await withCurrentAdministrator(actor, async session => {
        const prior = await operations().findOne({ 'cancellation.actor': actor, 'cancellation.operationId': operationId }, { session });
        if (prior) {
            if (prior.cancellation!.fingerprint !== fingerprint) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
            return prior;
        }
        if (await operations().findOne({ actor, operationId }, { session })) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
        const matches = await operations().find({ kind, ownerId, operationId: originalOperationId }, { session }).limit(2).toArray();
        if (!matches.length) return fail(404, 'ADMIN_CATALOG_COVER_NOT_FOUND');
        if (matches.length !== 1) return fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
        const current = matches[0];
        if (current.stage === 'attached') fail(409, 'ADMIN_CATALOG_COVER_ALREADY_ATTACHED');
        if (current.state === 'cancelled') fail(409, 'ADMIN_CATALOG_COVER_CANCELLED');
        if (current.leaseUntil && current.leaseUntil > new Date()) fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
        const owner = await readAdminCatalogRecord(kind, ownerId, session);
        if ((owner ? adminCatalogItemRevision(kind, owner) : null) !== body.expectedRevision) fail(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        // Fence concurrent owner edits/deletion as well as a newly claimed copy worker.
        await getDb()!.collection(collections[kind]).updateOne({ _id: new ObjectId(ownerId) },
            { $inc: { coverAdmissionRevision: 1 } }, { session });
        current.state = 'cancelled'; current.cleanupPending = Boolean(current.target);
        current.cancellation = { actor, operationId, fingerprint, expectedRevision: body.expectedRevision as string | null };
        current.updatedAt = new Date(); current.leaseOwner = null; current.leaseUntil = null;
        await operations().replaceOne({ _id: current._id }, current, { session });
        if (!current.target) await releaseSourcePin(current, session);
        return current;
    });
    await runAdminCatalogCoverOnce(dependencies, op._id.toHexString(), undefined, actor);
    return coverResult(actor, (await operations().findOne({ _id: op._id }))!, operationId);
}

/** Cancellation retains its pin until the exact destination is confirmed absent; unknown sends stay unresolved. */
async function cleanupCancelledCover(op: CoverOperation, worker: string, actor: string,
    storage: ImportObjectStorage, signal?: AbortSignal) {
    const authorize = () => withCurrentAdministrator(actor, async session => {
        const current = await operations().findOne({ _id: op._id, leaseOwner: worker, state: 'cancelled' }, { session });
        if (!current) return fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
        return current;
    });
    op = await authorize(); checkAdminWorker(signal);
    if (op.target) {
        const identity = await storage.head(op.target, signal);
        if (identity) {
            if (op.identity && (identity.etag !== op.identity.etag || identity.versionId !== op.identity.versionId)) fail(409, 'ADMIN_IMPORT_ASSET_CONFLICT');
            // Persist the exact version before DELETE; an ambiguous acknowledgement can then be reconciled by HEAD.
            await withCurrentAdministrator(actor, async session => {
                const result = await operations().updateOne({ _id: op._id, leaseOwner: worker, state: 'cancelled' },
                    { $set: { identity, updatedAt: new Date() } }, { session });
                if (!result.matchedCount) fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
            });
            op = await authorize(); checkAdminWorker(signal);
            await storage.delete({ ...op.target!, ...identity });
            checkAdminWorker(signal);
            if (await storage.head(op.target!, signal)) fail(503, 'ADMIN_CATALOG_COVER_UNKNOWN');
        } else if (op.stage === 'sent' && !op.identity) {
            // An earlier PUT may still settle. Absence is not proof that it was never accepted.
            fail(503, 'ADMIN_CATALOG_COVER_UNKNOWN');
        }
    }
    await withCurrentAdministrator(actor, async session => {
        checkAdminWorker(signal);
        const current = await operations().findOne({ _id: op._id, leaseOwner: worker, state: 'cancelled' }, { session });
        if (!current) return fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
        await releaseSourcePin(current, session);
        await operations().updateOne({ _id: op._id, leaseOwner: worker },
            { $set: { cleanupPending: false, leaseOwner: null, leaseUntil: null, updatedAt: new Date() } }, { session });
    });
}

/** Worker only retries known-safe reads; an unknown sent copy is never dispatched a second time. */
export async function runAdminCatalogCoverOnce(dependencies: AdminCatalogCoverDependencies = {}, onlyId?: string, signal?: AbortSignal, cleanupActor?: string): Promise<boolean> {
    if (signal?.aborted) return false;
    const storage = dependencies.storage ?? defaultImportObjectStorage, cleanup = dependencies.cleanup ?? cleanupDefault, worker = randomUUID();
    const claimed = await operations().findOneAndUpdate({ ...(onlyId ? { _id: new ObjectId(onlyId) } : {}), ...(onlyId ? unresolvedOperations : { state: 'copying' }), $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] }] }, { $set: { leaseOwner: worker, leaseUntil: new Date(Date.now() + 300_000) } }, { sort: { createdAt: 1 }, returnDocument: 'after' });
    let op = claimed.value; if (!op) return false;
    try {
        checkAdminWorker(signal);
        if (op.state === 'cancelled') {
            await cleanupCancelledCover(op, worker, cleanupActor ?? effectiveActor(op), storage, signal);
            return true;
        }
        await withCurrentAdministrator(op.actor, async session => {
            const current = await operations().findOne({ _id: op!._id, leaseOwner: worker, state: { $ne: 'cancelled' } }, { session });
            if (!current) return fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
            // An attached replacement needs no new publication authority to clean its detached old object.
            if (current.stage !== 'attached') { feature(); currentApproval(current); }
        });
        if (op.stage !== 'attached' && op.target) {
            if (op.target.bucket !== process.env.S3_BUCKET_NAME?.trim() || !importPrivateStorageReady()) fail(503, 'ADMIN_IMPORT_STORAGE_UNAVAILABLE');
            checkAdminWorker(signal);
            let identity = await storage.head(op.target, signal);
            if (op.stage === 'stored') { if (!identity || identity.etag !== op.identity?.etag || identity.versionId !== op.identity?.versionId) fail(409, 'ADMIN_IMPORT_ASSET_CONFLICT'); }
            else {
                if (!identity && op.stage === 'sent') fail(503, 'ADMIN_CATALOG_COVER_UNKNOWN');
                if (!identity) {
                    await withCurrentAdministrator(op.actor, async session => {
                        const current = await operations().findOne({ _id: op!._id, leaseOwner: worker, stage: 'reserved', state: { $ne: 'cancelled' } }, { session });
                        if (!current) return fail(409, 'ADMIN_CATALOG_COVER_ACTIVE');
                        feature(); currentApproval(current);
                        await operations().updateOne({ _id: current._id, leaseOwner: worker }, { $set: { stage: 'sent', updatedAt: new Date() } }, { session });
                    });
                    checkAdminWorker(signal);
                    try { identity = await storage.copy({ ...importAssetTarget(op.sourceImportId!, op.source!), etag: op.source!.etag!, versionId: op.source!.versionId }, op.target, signal); } catch { identity = await storage.head(op.target, signal); }
                }
                if (!identity) fail(503, 'ADMIN_CATALOG_COVER_UNKNOWN');
                const stored = await operations().findOneAndUpdate({ _id: op._id, leaseOwner: worker, state: { $ne: 'cancelled' } }, { $set: { stage: 'stored', identity, updatedAt: new Date() } }, { returnDocument: 'after' }); if (!stored.value) fail(409, 'ADMIN_CATALOG_COVER_ACTIVE'); op = stored.value!;
            }
        }
        checkAdminWorker(signal);
        if (op.stage !== 'attached') {
            const captured = op;
            const attach = () => withCurrentAdministrator(captured.actor, async session => {
                checkAdminWorker(signal); feature(); const current = await operations().findOne({ _id: captured._id, leaseOwner: worker, stage: 'stored', state: { $ne: 'cancelled' } }, { session }); if (!current) return fail(409, 'ADMIN_CATALOG_COVER_ACTIVE'); currentApproval(current);
                const owner = await readAdminCatalogRecord(captured.kind, captured.ownerId, session); if (!owner || adminCatalogItemRevision(captured.kind, owner) !== captured.expectedRevision) fail(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
                if (captured.target) { await requireDelivery(captured.kind, owner, session); await getDb()!.collection('imageAssets').insertOne({ _id: new ObjectId(captured.imageId!), ownerType: captured.kind, ownerId: captured.ownerId, createdBy: captured.actor, originalFileName: captured.source!.filename, contentType: captured.source!.contentType, s3Key: captured.target.key, uploadStatus: 'ready', uploadUpdatedAt: new Date(), uploadError: null, uploadOutcomeUnknown: false, storageIdentity: captured.identity }, { session }); }
                const update = captured.imageId ? { $set: { coverArtId: captured.imageId, coverArtUrl: `/content/images/${captured.imageId}` }, $inc: { adminRevision: 1 } } : { $unset: { coverArtId: '' }, $set: { coverArtUrl: '' }, $inc: { adminRevision: 1 } };
                const result = await getDb()!.collection(collections[captured.kind]).updateOne({ _id: owner!._id }, update, { session });
                await operations().updateOne({ _id: captured._id, leaseOwner: worker }, { $set: { stage: 'attached', state: 'complete', cleanupPending: Boolean(captured.previousImageId), updatedAt: new Date() } }, { session });
                await releaseSourcePin(captured, session);
                checkAdminWorker(signal); currentApproval(current); return result;
            });
            const outcome = await updateCoverArtOwnerAndCleanup(op.ownerId, op.imageId ? { coverArtId: op.imageId, coverArtUrl: `/content/images/${op.imageId}` } : { coverArtId: null, coverArtUrl: '' }, op.previousImageId, true, {
                ownerType: op.kind, updateOwner: attach, updateOwnerIfCoverArtMatches: attach,
                deleteAsset: id => { checkAdminWorker(signal); return cleanup(id, captured.kind, captured.ownerId); },
                deleteReplacementAsset: async () => { throw new Error('Keep exact replacement evidence for reconciliation'); }
            });
            op = (await operations().findOne({ _id: captured._id, leaseOwner: worker }))!;
            if (op.stage !== 'attached') fail(503, 'ADMIN_CATALOG_COVER_UNKNOWN');
            await operations().updateOne({ _id: op._id, leaseOwner: worker }, { $set: { cleanupPending: outcome.cleanupPending, state: 'complete', updatedAt: new Date() } });
        } else if (op.cleanupPending && op.previousImageId) { checkAdminWorker(signal); await cleanup(op.previousImageId, op.kind, op.ownerId); await operations().updateOne({ _id: op._id, leaseOwner: worker }, { $set: { cleanupPending: false, updatedAt: new Date() } }); }
        await operations().updateOne({ _id: op._id, leaseOwner: worker }, { $set: { leaseOwner: null, leaseUntil: null } });
    } catch {
        // A lost transaction acknowledgement cannot downgrade an already committed attachment.
        await operations().updateOne({ _id: op._id, leaseOwner: worker, stage: { $ne: 'attached' }, state: { $ne: 'cancelled' } }, { $set: { state: 'needsAttention', cleanupPending: true, leaseOwner: null, leaseUntil: null, updatedAt: new Date() } });
        await operations().updateOne({ _id: op._id, leaseOwner: worker, stage: 'attached' }, { $set: { state: 'complete', leaseOwner: null, leaseUntil: null, updatedAt: new Date() } });
        await operations().updateOne({ _id: op._id, leaseOwner: worker, state: 'cancelled' }, { $set: { leaseOwner: null, leaseUntil: null, updatedAt: new Date() } });
    }
    return true;
}
/** Reconciliation uses the durable approval; clients never reconstruct its private source or old revision. */
export async function reconcileAdminCatalogCover(actor: string, kind: AdminCatalogKind, ownerId: string, operationId: string, dependencies: AdminCatalogCoverDependencies = {}) {
    if (!uuid(operationId) || !objectId(ownerId)) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const op = await withCurrentAdministrator(actor, async session => {
        const rows = await operations().find({ kind: requireKind(kind), ownerId, operationId,
            $or: [{ actor }, { state: 'cancelled' }] }, { session }).limit(2).toArray();
        if (rows.length > 1) return fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT'); return rows[0];
    }); if (!op) return fail(404, 'ADMIN_CATALOG_COVER_NOT_FOUND');
    await runAdminCatalogCoverOnce(dependencies, op._id.toHexString(), undefined, actor); return coverResult(actor, (await operations().findOne({ _id: op._id }))!);
}
export function startAdminCatalogCoverWorker(intervalMs = 2000, track?: AdminWorkTracker) { return startAdminWorker(signal => runAdminCatalogCoverOnce({}, undefined, signal), intervalMs, track); }
