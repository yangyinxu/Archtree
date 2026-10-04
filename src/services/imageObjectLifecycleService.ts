import { DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { getS3 } from '../infrastructure/s3';
import type { ImageAssetRecord, ImageStorageIdentity } from '../models/imageAsset';

export class ImageStorageReconciliationRequiredError extends Error {
    readonly statusCode = 503;
    readonly code = 'image_storage_reconciliation_required';
    readonly cleanupPending = true;
    readonly reconciliationRequired = true;
    constructor() { super('Image storage identity requires explicit reconciliation before cleanup.'); }
}

/** A missing VersionId in an acknowledged PUT denotes the exact null version. */
export const imageStorageIdentity = (result: { ETag?: string; VersionId?: string }): ImageStorageIdentity => {
    if (!result.ETag || typeof result.ETag !== 'string' || result.ETag.length > 256
        || (result.VersionId !== undefined && (typeof result.VersionId !== 'string' || !result.VersionId || result.VersionId.length > 1024))) {
        throw new ImageStorageReconciliationRequiredError();
    }
    return { etag: result.ETag, versionId: result.VersionId ?? null };
};

/** Deletes only confirmed versions. A key-only DELETE cannot prove erasure. */
export const deleteImageStorageObject = async (
    asset: Pick<ImageAssetRecord, 's3Key' | 'storageIdentity' | 'storageCleanupVersions' | 'storageDeleteMarkers' | 'storageDeleted' | 'uploadOutcomeUnknown'>,
    send: (command: DeleteObjectCommand) => Promise<unknown> = command => getS3().send(command)
) => {
    if (asset.uploadOutcomeUnknown) throw new ImageStorageReconciliationRequiredError();
    if (asset.storageDeleted) return;
    const versions = asset.storageCleanupVersions ?? (asset.storageIdentity ? [asset.storageIdentity] : undefined);
    if (!versions || (!versions.length && !asset.storageDeleteMarkers?.length)) throw new ImageStorageReconciliationRequiredError();
    for (const version of versions) {
        imageStorageIdentity({ ETag: version.etag, VersionId: version.versionId ?? undefined });
        await send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!, Key: asset.s3Key,
            // Version deletion cannot use If-Match: S3 evaluates conditional deletes
            // only against the current object. Unique conditional PUT keys and the
            // legacy quiescence gate prevent null-version replacement by old writers.
            VersionId: version.versionId ?? 'null'
        }));
    }
    for (const versionId of asset.storageDeleteMarkers ?? []) {
        if (!versionId || versionId.length > 1024) throw new ImageStorageReconciliationRequiredError();
        await send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME!, Key: asset.s3Key, VersionId: versionId }));
    }
};

type ImageVersionInventoryDependencies = {
    list: (command: ListObjectVersionsCommand) => Promise<any>;
    head: (command: HeadObjectCommand) => Promise<any>;
};

/** Read-only, bounded exact-key inventory; never infers absence from the latest-key listing. */
export const inspectImageStorageVersions = async (
    asset: Pick<ImageAssetRecord, '_id' | 'ownerType' | 'ownerId' | 's3Key'>,
    dependencies: Partial<ImageVersionInventoryDependencies> = {}
) => {
    const expectedKey = `${asset.ownerType === 'user' ? 'avatars' : 'images'}/${String(asset._id).toLowerCase()}`;
    if (!/^[0-9a-f]{24}$/.test(String(asset._id).toLowerCase()) || asset.s3Key !== expectedKey) throw new ImageStorageReconciliationRequiredError();
    const list = dependencies.list ?? (command => getS3().send(command));
    const head = dependencies.head ?? (command => getS3().send(command));
    const versions: ImageStorageIdentity[] = [];
    const deleteMarkers: string[] = [];
    let current: ImageStorageIdentity | undefined;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    const seen = new Set<string>();
    do {
        const page = await list(new ListObjectVersionsCommand({
            Bucket: process.env.S3_BUCKET_NAME!, Prefix: asset.s3Key, MaxKeys: 100,
            KeyMarker: keyMarker, VersionIdMarker: versionIdMarker
        }));
        for (const version of page.Versions ?? []) {
            if (version.Key !== asset.s3Key) continue;
            if (!version.VersionId || typeof version.VersionId !== 'string') throw new ImageStorageReconciliationRequiredError();
            const object = await head(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_NAME!, Key: asset.s3Key, VersionId: version.VersionId }));
            if (object.Metadata?.imageid !== String(asset._id).toLowerCase()
                || object.Metadata?.ownertype !== asset.ownerType
                || object.Metadata?.ownerid !== String(asset.ownerId)) throw new ImageStorageReconciliationRequiredError();
            const identity = imageStorageIdentity({ ETag: object.ETag, VersionId: version.VersionId === 'null' ? undefined : version.VersionId });
            if (version.ETag !== identity.etag) throw new ImageStorageReconciliationRequiredError();
            versions.push(identity);
            if (version.IsLatest) current = identity;
        }
        for (const marker of page.DeleteMarkers ?? []) {
            if (marker.Key !== asset.s3Key) continue;
            if (!marker.VersionId || typeof marker.VersionId !== 'string') throw new ImageStorageReconciliationRequiredError();
            deleteMarkers.push(marker.VersionId);
        }
        if (versions.length + deleteMarkers.length > 100) throw new ImageStorageReconciliationRequiredError();
        if (!page.IsTruncated) break;
        if (!page.NextKeyMarker || !page.NextVersionIdMarker) throw new ImageStorageReconciliationRequiredError();
        const token = JSON.stringify([page.NextKeyMarker, page.NextVersionIdMarker]);
        if (seen.has(token) || seen.size >= 10) throw new ImageStorageReconciliationRequiredError();
        seen.add(token);
        keyMarker = page.NextKeyMarker;
        versionIdMarker = page.NextVersionIdMarker;
    } while (true);
    return { versions, deleteMarkers, current };
};
