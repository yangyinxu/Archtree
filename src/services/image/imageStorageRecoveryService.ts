import { ObjectId, type Db } from 'mongodb';
import { inspectImageStorageVersions, ImageStorageReconciliationRequiredError } from './imageObjectLifecycleService';

/** Explicit operator recovery records exact versions after all old upload workers are stopped. */
export const reconcileImageStorageIdentity = async (
    db: Db, imageId: string, apply = false, uploadWorkersQuiescent = false,
    inspect = inspectImageStorageVersions
) => {
    if (!/^[a-f\d]{24}$/i.test(imageId) || (apply && !uploadWorkersQuiescent)) throw new ImageStorageReconciliationRequiredError();
    const _id = new ObjectId(imageId);
    const assets = db.collection('imageAssets');
    const asset = await assets.findOne({ _id });
    if (!asset) throw new ImageStorageReconciliationRequiredError();
    if (asset.ownerType === 'user' && await db.collection('avatarMutations').findOne({
        userId: String(asset.ownerId), status: 'pending', leaseUntil: { $gt: new Date() }
    })) throw new ImageStorageReconciliationRequiredError();
    const inventory = await inspect(asset as any);
    const report = { imageId: _id.toHexString(), versionCount: inventory.versions.length,
        deleteMarkerCount: inventory.deleteMarkers.length, applied: false };
    if (!apply) return report;
    const unchanged = Object.fromEntries(['s3Key', 'ownerId', 'ownerType', 'uploadStatus', 'uploadUpdatedAt', 'uploadOutcomeUnknown']
        .map(key => [key, asset[key] === undefined ? { $exists: false } : asset[key]]));
    const result = await assets.updateOne({ _id, ...unchanged }, {
        $set: {
            storageCleanupVersions: inventory.versions, storageDeleteMarkers: inventory.deleteMarkers,
            storageDeleted: inventory.versions.length === 0 && inventory.deleteMarkers.length === 0,
            uploadOutcomeUnknown: false, uploadUpdatedAt: new Date(), uploadError: null,
            ...(inventory.current ? { storageIdentity: inventory.current } : {}),
            ...(asset.uploadStatus === 'pending' ? { uploadStatus: 'failed' } : {})
        },
        ...(!inventory.current ? { $unset: { storageIdentity: '' } } : {})
    });
    if (result.matchedCount !== 1) throw new ImageStorageReconciliationRequiredError();
    return { ...report, applied: true };
};
