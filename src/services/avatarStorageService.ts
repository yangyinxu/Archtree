import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import { maxAvatarUploadMb } from '../middleware/imageUpload';
import { ImageAsset } from '../models/imageAsset';
import { normalizeUtf8Text } from '../utils/textEncoding';

export const maxAvatarPixels = 16_000_000;
const avatarOutputSize = 1_024;
const maximumAvatarCleanupBatch = 100;

const errorMessage = (error: unknown) => {
    return (error instanceof Error ? error.message : String(error)).substring(0, 500);
};

/** Binds private avatar reads and deletions to the authenticated image identity. */
export const isAvatarObjectKeyForImage = (value: unknown, imageId: string) => {
    const normalizedImageId = imageId.toLowerCase();
    return /^[0-9a-f]{24}$/.test(normalizedImageId)
        && typeof value === 'string'
        && value === `avatars/${normalizedImageId}`;
};

/** Isolates private-avatar storage boundaries for deterministic deletion retries. */
export interface AvatarAssetDeletionDependencies {
    findAsset: (imageId: string) => Promise<any | null>;
    updateAsset: (
        imageId: string,
        update: Record<string, unknown>
    ) => Promise<{ matchedCount: number }>;
    deleteObject: (s3Key: string) => Promise<void>;
    deleteAsset: (imageId: string) => Promise<{ deletedCount: number }>;
}

export class AvatarMutationOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'avatar_mutation_outcome_unknown';
    readonly cleanupPending = true;
    readonly cause: unknown;

    constructor(cause: unknown) {
        super('Avatar mutation outcome could not be confirmed.');
        this.cause = cause;
    }
}

const defaultAvatarAssetDeletionDependencies: AvatarAssetDeletionDependencies = {
    findAsset: imageId => ImageAsset.findById(imageId),
    updateAsset: (imageId, update) => ImageAsset.updateById(imageId, update),
    deleteObject: async s3Key => {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key
        }));
    },
    deleteAsset: imageId => ImageAsset.deleteById(imageId)
};

/** Fully decodes untrusted avatar bytes before producing metadata-free server output. */
export const normalizeAvatar = async (uploadFile: Express.Multer.File) => {
    const maxBytes = maxAvatarUploadMb * 1024 * 1024;
    if (!uploadFile.buffer || uploadFile.size > maxBytes || uploadFile.buffer.length > maxBytes) {
        throw Object.assign(new Error(`Avatar is too large. The maximum size is ${maxAvatarUploadMb} MB.`), {
            statusCode: 413
        });
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(uploadFile.mimetype)) {
        throw Object.assign(new Error('Avatar must be a valid JPG, PNG, or WebP image.'), {
            statusCode: 400
        });
    }

    try {
        const metadata = await sharp(
            uploadFile.buffer,
            { limitInputPixels: maxAvatarPixels }
        ).metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (!width || !height || width * height > maxAvatarPixels) {
            throw Object.assign(new Error('Avatar pixel dimensions are too large.'), { statusCode: 400 });
        }
    } catch {
        throw Object.assign(new Error('Avatar must be a valid JPG, PNG, or WebP image.'), {
            statusCode: 400
        });
    }

    try {
        return await sharp(uploadFile.buffer, { limitInputPixels: maxAvatarPixels })
            .rotate()
            .resize(avatarOutputSize, avatarOutputSize, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer();
    } catch {
        throw Object.assign(new Error('Avatar could not be processed.'), { statusCode: 400 });
    }
};

/** Stages one private, account-owned avatar with a traceable S3 lifecycle record. */
export const uploadAvatar = async (userId: string, uploadFile: Express.Multer.File) => {
    const body = await normalizeAvatar(uploadFile);
    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    const s3Key = `avatars/${imageId}`;
    const now = new Date();

    await ImageAsset.insert({
        _id: imageObjectId,
        ownerType: 'user',
        ownerId: userId,
        createdBy: userId,
        originalFileName: normalizeUtf8Text(uploadFile.originalname),
        contentType: 'image/jpeg',
        s3Key,
        uploadStatus: 'pending',
        uploadUpdatedAt: now,
        uploadError: null
    });

    try {
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key,
            Body: body,
            ContentLength: body.length,
            ContentType: 'image/jpeg',
            CacheControl: 'private, max-age=86400',
            Metadata: { imageid: imageId, ownertype: 'user', ownerid: userId }
        }));
        const readyUpdate = await ImageAsset.updateById(imageId, {
            uploadStatus: 'ready',
            uploadUpdatedAt: new Date(),
            uploadError: null
        });
        if (readyUpdate.matchedCount !== 1) {
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: s3Key
            }));
            throw new Error(`Avatar lifecycle record ${imageId} could not be finalized.`);
        }
        return imageId;
    } catch (error) {
        await ImageAsset.updateById(imageId, {
            uploadStatus: 'failed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch(() => undefined);
        throw error;
    }
};

/** Reads only a ready avatar owned by the authenticated account. */
export const getAvatarObject = async (
    imageId: string,
    userId: string,
    options: { ifNoneMatch?: string; abortSignal?: AbortSignal } = {}
) => {
    const asset = await ImageAsset.findById(imageId);
    if (!asset || asset.uploadStatus !== 'ready'
        || asset.ownerType !== 'user' || String(asset.ownerId) !== userId
        || !isAvatarObjectKeyForImage(asset.s3Key, imageId)) {
        return null;
    }
    try {
        const object = await getS3().send(new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: String(asset.s3Key),
            IfNoneMatch: options.ifNoneMatch
        }), { abortSignal: options.abortSignal });
        return { asset, object, notModified: false as const };
    } catch (error: any) {
        if (error?.$metadata?.httpStatusCode === 304) {
            return { asset, notModified: true as const };
        }
        throw error;
    }
};

/** Deletes only the recorded object and retains its database evidence for owner finalization. */
export const prepareAvatarAssetDeletion = async (
    imageId: string,
    userId: string,
    dependencies: Partial<AvatarAssetDeletionDependencies> = {}
) => {
    const deletion = { ...defaultAvatarAssetDeletionDependencies, ...dependencies };
    const asset = await deletion.findAsset(imageId);
    if (!asset) {
        throw new Error('Avatar lifecycle evidence is missing.');
    }
    if (asset.ownerType !== 'user' || String(asset.ownerId) !== userId
        || !isAvatarObjectKeyForImage(asset.s3Key, imageId)) {
        throw new Error('Avatar lifecycle ownership or storage key is invalid.');
    }
    const deletingUpdate = await deletion.updateAsset(imageId, {
        uploadStatus: 'deleting',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });
    if (deletingUpdate.matchedCount !== 1) {
        throw new Error(`Avatar lifecycle record ${imageId} could not be prepared.`);
    }
    try {
        await deletion.deleteObject(String(asset.s3Key));
    } catch (error) {
        await deletion.updateAsset(imageId, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch(() => undefined);
        throw error;
    }
};

/** Removes private-avatar lifecycle evidence only after no account references it. */
export const finalizeAvatarAssetDeletion = async (
    imageId: string,
    dependencies: Partial<AvatarAssetDeletionDependencies> = {}
) => {
    const deletion = { ...defaultAvatarAssetDeletionDependencies, ...dependencies };
    const deleted = await deletion.deleteAsset(imageId);
    if (deleted.deletedCount !== 1) {
        throw new Error(`Avatar lifecycle record ${imageId} could not be finalized.`);
    }
};

/** Cleans up an avatar that has already been detached from its account owner. */
export const deleteAvatarAsset = async (
    imageId: string,
    userId: string,
    dependencies: Partial<AvatarAssetDeletionDependencies> = {}
) => {
    await prepareAvatarAssetDeletion(imageId, userId, dependencies);
    await finalizeAvatarAssetDeletion(imageId, dependencies);
};

/** Confirms a lost avatar-attachment response before choosing old/new asset cleanup. */
export const replaceAvatarOwnerAndCleanup = async (
    imageId: string,
    userId: string,
    previousImageId: string,
    expectedRevision: number,
    replaceOwner: () => Promise<{ value?: unknown }>,
    findOwner: () => Promise<any | null>,
    dependencies: Partial<AvatarAssetDeletionDependencies> = {}
) => {
    let previousOwner: any | null = null;
    let replaceError: unknown;
    try {
        const replacement = await replaceOwner();
        previousOwner = replacement.value ?? null;
    } catch (error) {
        replaceError = error;
    }

    let currentOwner: any | null = null;
    let ownerReplaced = Boolean(previousOwner);
    if (!ownerReplaced) {
        try {
            currentOwner = await findOwner();
        } catch (confirmationError) {
            throw new AvatarMutationOutcomeUnknownError({ replaceError, confirmationError });
        }
        ownerReplaced = Number(currentOwner?.avatarRevision ?? 0) === expectedRevision + 1
            && String(currentOwner?.avatarAssetId ?? '') === imageId;
    }

    if (!ownerReplaced) {
        let cleanupPending = false;
        let cleanupError: unknown;
        try {
            await deleteAvatarAsset(imageId, userId, dependencies);
        } catch (error) {
            cleanupPending = true;
            cleanupError = error;
        }
        return { ownerReplaced: false, cleanupPending, cleanupError, currentOwner };
    }

    let cleanupPending = false;
    let cleanupError: unknown;
    if (previousImageId && previousImageId !== imageId) {
        try {
            await deleteAvatarAsset(previousImageId, userId, dependencies);
        } catch (error) {
            cleanupPending = true;
            cleanupError = error;
        }
    }
    return { ownerReplaced: true, cleanupPending, cleanupError, currentOwner };
};

/** Clears the account reference between object deletion and lifecycle-record finalization. */
export const deleteAvatarOwnerAndAsset = async (
    imageId: string,
    userId: string,
    clearOwner: () => Promise<{ value?: unknown }>,
    dependencies: Partial<AvatarAssetDeletionDependencies> & {
        confirmOwnerCleared?: () => Promise<boolean>;
    } = {}
) => {
    await prepareAvatarAssetDeletion(imageId, userId, dependencies);
    let ownerCleared = false;
    let clearError: unknown;
    try {
        const cleared = await clearOwner();
        ownerCleared = Boolean(cleared.value);
    } catch (error) {
        clearError = error;
    }
    if (!ownerCleared && dependencies.confirmOwnerCleared) {
        try {
            ownerCleared = await dependencies.confirmOwnerCleared();
        } catch (confirmationError) {
            throw new AvatarMutationOutcomeUnknownError({ clearError, confirmationError });
        }
    }
    if (!ownerCleared) {
        if (clearError) throw clearError;
        return { ownerCleared: false, cleanupPending: true };
    }
    try {
        await finalizeAvatarAssetDeletion(imageId, dependencies);
        return { ownerCleared: true, cleanupPending: false };
    } catch (cleanupError) {
        return { ownerCleared: true, cleanupPending: true, cleanupError };
    }
};

/**
 * Retries every detached private-avatar lifecycle record while preserving the
 * account's current winning avatar, if another confirmed image is attached.
 */
export const cleanupDetachedAvatarAssets = async (
    userId: string,
    dependencies: Partial<AvatarAssetDeletionDependencies> = {}
) => {
    if (!/^[0-9a-f]{24}$/i.test(userId)) {
        return { cleanupPending: false, cleanupErrors: [] as unknown[] };
    }
    const canonicalUserId = ObjectId.createFromHexString(userId).toHexString();
    const userObjectId = ObjectId.createFromHexString(canonicalUserId);
    const db = getDb()!;
    const owner = await db.collection('users').findOne(
        { _id: userObjectId },
        { projection: { avatarAssetId: 1 } }
    );
    const currentAvatarId = String(owner?.avatarAssetId ?? '').toLowerCase();
    const assets = await db.collection('imageAssets').find({
        ownerType: 'user',
        ownerId: { $in: [canonicalUserId, userObjectId] }
    }).project({ _id: 1 })
        .sort({ _id: 1 })
        .limit(maximumAvatarCleanupBatch + 1)
        .toArray();
    const cleanupErrors: unknown[] = [];
    if (assets.length > maximumAvatarCleanupBatch) {
        cleanupErrors.push(new Error('Additional private-avatar cleanup remains pending.'));
    }

    for (const asset of assets.slice(0, maximumAvatarCleanupBatch)) {
        const imageId = String(asset._id).toLowerCase();
        if (imageId === currentAvatarId) continue;
        try {
            await deleteAvatarAsset(imageId, canonicalUserId, dependencies);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    return {
        cleanupPending: cleanupErrors.length > 0,
        cleanupErrors
    };
};

/** Clears the winning avatar and retries all older detached assets under one mutation lease. */
export const deleteAvatarOwnerAndAllAssets = async (
    imageId: string,
    userId: string,
    clearOwner: () => Promise<{ value?: unknown }>,
    dependencies: Partial<AvatarAssetDeletionDependencies> & {
        confirmOwnerCleared?: () => Promise<boolean>;
    } = {}
) => {
    const deletion = await deleteAvatarOwnerAndAsset(
        imageId,
        userId,
        clearOwner,
        dependencies
    );
    if (!deletion.ownerCleared) return deletion;

    const detached = await cleanupDetachedAvatarAssets(userId, dependencies);
    return {
        ...deletion,
        cleanupPending: deletion.cleanupPending || detached.cleanupPending,
        cleanupErrors: detached.cleanupErrors
    };
};
