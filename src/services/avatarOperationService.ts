import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { ImageAsset } from '../models/imageAsset';
import User from '../models/user';
import {
    AvatarLeaseLostError, beginAvatarMutation, completeAvatarMutation, keepAvatarMutationLease,
    releaseAvatarMutation, setAvatarMutationPhase, withAvatarMutationLease,
    type AvatarMutationKind, type AvatarMutationLease, type AvatarMutationResult
} from './avatarMutationService';
import {
    cleanupDetachedAvatarAssets, deleteAvatarAsset, finalizeAvatarAssetDeletion,
    prepareAvatarAssetDeletion, uploadAvatar
} from './avatarStorageService';

const profile = (user: any) => {
    const avatarRevision = Number(user?.avatarRevision ?? 0);
    const id = String(user?.avatarAssetId ?? '');
    return { avatarRevision, avatar: id ? { assetId: id, revision: avatarRevision } : null };
};
const revisionFilter = (revision: number) => revision === 0
    ? { $or: [{ avatarRevision: 0 }, { avatarRevision: { $exists: false } }] }
    : { avatarRevision: revision };

/** Storage calls may finish late; only this transaction can publish their result. */
const promote = async (lease: AvatarMutationLease) => {
    const { userId, expectedRevision, assetId } = lease.record;
    await setAvatarMutationPhase(lease, 'promoted', {}, async session => {
        const asset = await getDb()!.collection('imageAssets').findOne({
            _id: new ObjectId(assetId), ownerType: 'user', ownerId: userId, avatarMutationId: lease.mutationId,
            uploadOutcomeUnknown: false, storageDeleted: { $ne: true },
            uploadStatus: { $in: ['ready', 'failed'] }, 'storageIdentity.etag': { $exists: true }
        }, { session });
        if (!asset) throw new Error('Avatar upload identity is not confirmed.');
        await getDb()!.collection('imageAssets').updateOne({ _id: asset._id }, { $set: { uploadStatus: 'ready' } }, { session });
        const changed = await getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId), ...revisionFilter(expectedRevision) },
            { $set: { avatarAssetId: assetId, avatarUpdatedAt: new Date() }, $inc: { avatarRevision: 1 } }, { session }
        );
        if (changed.matchedCount !== 1) throw new AvatarLeaseLostError();
    });
};

const clearOwner = async (lease: AvatarMutationLease) => {
    const { userId, expectedRevision, assetId } = lease.record;
    await setAvatarMutationPhase(lease, 'cleared', {}, async session => {
        if (!assetId) return;
        const changed = await getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId), avatarAssetId: assetId, ...revisionFilter(expectedRevision) },
            { $set: { avatarAssetId: null, avatarUpdatedAt: new Date() }, $inc: { avatarRevision: 1 } }, { session }
        );
        if (changed.matchedCount !== 1) throw new AvatarLeaseLostError();
    });
};

/** Explicit dependency boundaries support crash/late-worker tests without live storage. */
export interface AvatarOperationDependencies {
    owner: (userId: string) => Promise<any>;
    asset: (imageId: string) => Promise<any>;
    phase: typeof setAvatarMutationPhase;
    promote: typeof promote;
    clearOwner: typeof clearOwner;
    upload: typeof uploadAvatar;
    prepareDelete: typeof prepareAvatarAssetDeletion;
    finalizeDelete: typeof finalizeAvatarAssetDeletion;
    deleteDetached: typeof deleteAvatarAsset;
    cleanup: typeof cleanupDetachedAvatarAssets;
    assertLease: (lease: AvatarMutationLease) => Promise<unknown>;
}
const defaults: AvatarOperationDependencies = {
    owner: async id => User.findById(id), asset: ImageAsset.findById.bind(ImageAsset),
    phase: setAvatarMutationPhase, promote, clearOwner, upload: uploadAvatar,
    prepareDelete: prepareAvatarAssetDeletion, finalizeDelete: finalizeAvatarAssetDeletion,
    deleteDetached: deleteAvatarAsset, cleanup: cleanupDetachedAvatarAssets,
    assertLease: lease => withAvatarMutationLease(lease, async () => undefined)
};

/** Resumes from durable facts; missing upload acknowledgement never authorizes deletion. */
export const runAvatarOperation = async (
    lease: AvatarMutationLease, file?: Express.Multer.File, recovering = false,
    dependencies: Partial<AvatarOperationDependencies> = {}
): Promise<AvatarMutationResult> => {
    const operation = { ...defaults, ...dependencies };
    const record = lease.record;
    let user = await operation.owner(record.userId);
    if (!user) return { statusCode: 404, body: { message: 'Account not found.' } };
    const interrupted = () => ({ statusCode: 503, body: {
        message: 'The interrupted avatar upload needs storage reconciliation. Start a new operation after refreshing the account.',
        cleanupPending: true, ...profile(user)
    } });
    // Legacy receipts cannot identify their dispatch point. Keep all asset evidence,
    // retire the stale receipt, and allow an explicitly new operation to proceed.
    if (!record.phase) return interrupted();
    if (record.phase === 'reserved' && recovering) {
        return { statusCode: 409, body: { message: 'The avatar operation stopped before upload. Start a new operation.', ...profile(user) } };
    }
    if (record.phase === 'reserved') {
        if (profile(user).avatarRevision !== record.expectedRevision) {
            return { statusCode: 409, body: { message: 'Avatar changed on another device.', ...profile(user) } };
        }
        if (record.kind === 'replace') {
            if (!file) return { statusCode: 400, body: { message: 'Select an avatar image to upload.' } };
            await operation.phase(lease, 'reserved', { previousAssetId: String(user.avatarAssetId ?? '') });
            await operation.upload(record.userId, file, lease);
        } else {
            await operation.phase(lease, 'deleting', { assetId: String(user.avatarAssetId ?? '') });
        }
    }
    if (record.kind === 'replace') {
        if (record.phase === 'uploading') {
            const asset = record.assetId ? await operation.asset(record.assetId) : null;
            if (!asset || asset.ownerType !== 'user' || String(asset.ownerId) !== record.userId
                || asset.avatarMutationId !== lease.mutationId
                || asset.uploadOutcomeUnknown !== false || asset.storageDeleted || !asset.storageIdentity?.etag
                || !['ready', 'failed'].includes(asset.uploadStatus)) return interrupted();
            await operation.phase(lease, 'uploaded');
        }
        if (record.phase === 'uploaded') {
            if (profile(user).avatarRevision !== record.expectedRevision) {
                let cleanupPending = false;
                if (String(user.avatarAssetId ?? '') !== record.assetId && record.assetId) {
                    try { await operation.assertLease(lease); await operation.deleteDetached(record.assetId, record.userId, {}, { lease, detached: true }); }
                    catch { cleanupPending = true; }
                }
                return { statusCode: 409, body: { message: 'Avatar changed on another device.', ...profile(user), cleanupPending } };
            }
            await operation.promote(lease);
        }
    } else {
        if (record.phase === 'deleting') {
            if (profile(user).avatarRevision !== record.expectedRevision || String(user.avatarAssetId ?? '') !== String(record.assetId ?? '')) {
                return { statusCode: 409, body: { message: 'Avatar changed on another device.', ...profile(user), cleanupPending: true } };
            }
            await operation.assertLease(lease);
            if (record.assetId) await operation.prepareDelete(record.assetId, record.userId, {}, { lease, detached: false });
            await operation.clearOwner(lease);
        }
        if (record.phase === 'cleared' && record.assetId) {
            // A previous retry may already have finalized the record.
            if (await operation.asset(record.assetId)) {
                await operation.assertLease(lease);
                try { await operation.finalizeDelete(record.assetId, {}, { lease, detached: true }); } catch { /* Batch cleanup retries below. */ }
            }
        }
    }
    await operation.assertLease(lease);
    const cleanup = await operation.cleanup(record.userId, {}, lease);
    user = await operation.owner(record.userId);
    return { statusCode: 200, body: { ...profile(user), cleanupPending: cleanup.cleanupPending } };
};

/** Recovery uses the old intent first; the incoming key never impersonates it. */
export const executeAvatarMutation = async (
    userId: string, key: string, kind: AvatarMutationKind, revision: number, file?: Express.Multer.File
) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const reservation = await beginAvatarMutation(userId, key, kind, revision);
        if (!reservation.isOwner || !reservation.lease) return reservation.result!;
        const lease = reservation.lease;
        const stop = keepAvatarMutationLease(lease);
        try {
            const result = await runAvatarOperation(lease, file, reservation.recovery);
            await completeAvatarMutation(lease, result);
            // The same key replays the recovered intent; a new key can now reserve.
            const { createHash } = await import('node:crypto');
            const requestedId = createHash('sha256').update(`${userId}\0${key}`).digest('hex');
            if (reservation.recovery && lease.mutationId !== requestedId) continue;
            return result;
        } catch (error) {
            await releaseAvatarMutation(lease).catch(() => undefined);
            if (error instanceof AvatarLeaseLostError) throw error;
            if (lease.record.phase !== 'reserved') {
                return { statusCode: 503, body: { message: 'Avatar operation is awaiting recovery. Refresh and retry.', cleanupPending: true } };
            }
            throw error;
        } finally { stop(); }
    }
    throw new AvatarLeaseLostError();
};
