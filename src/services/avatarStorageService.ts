import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { getS3 } from '../infrastructure/s3';
import { maxAvatarUploadMb } from '../middleware/imageUpload';
import { ImageAsset } from '../models/imageAsset';
import { normalizeUtf8Text } from '../utils/textEncoding';

export const maxAvatarPixels = 16_000_000;
const avatarOutputSize = 1_024;

const errorMessage = (error: unknown) => {
    return (error instanceof Error ? error.message : String(error)).substring(0, 500);
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
        await ImageAsset.updateById(imageId, {
            uploadStatus: 'ready',
            uploadUpdatedAt: new Date(),
            uploadError: null
        });
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
        || asset.ownerType !== 'user' || String(asset.ownerId) !== userId) {
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

/** Deletes an avatar while retaining failed lifecycle evidence for reconciliation. */
export const deleteAvatarAsset = async (imageId: string, userId: string) => {
    const asset = await ImageAsset.findById(imageId);
    if (!asset || asset.ownerType !== 'user' || String(asset.ownerId) !== userId) {
        return;
    }
    await ImageAsset.updateById(imageId, {
        uploadStatus: 'deleting',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });
    try {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: String(asset.s3Key)
        }));
        await ImageAsset.deleteById(imageId);
    } catch (error) {
        await ImageAsset.updateById(imageId, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch(() => undefined);
        throw error;
    }
};
