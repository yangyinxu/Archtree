import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import { getS3 } from '../infrastructure/s3';
import { ImageAsset, ImageOwnerType } from '../models/imageAsset';
import { maxImageUploadMb } from '../middleware/imageUpload';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { coverArtUrlForId } from '../utils/coverArt';

const allowedImageTypes = new Map<string, (buffer: Buffer) => boolean>([
    ['image/jpeg', (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff],
    ['image/png', (buffer) => buffer.length >= 8
        && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
            .every((byte, index) => buffer[index] === byte)],
    ['image/webp', (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP']
]);

const errorMessage = (error: unknown) => {
    return (error instanceof Error ? error.message : String(error)).substring(0, 500);
};

export const validateCoverArtFile = (uploadFile: Express.Multer.File) => {
    const maxBytes = maxImageUploadMb * 1024 * 1024;
    if (uploadFile.size > maxBytes || uploadFile.buffer.length > maxBytes) {
        throw Object.assign(
            new Error(`Cover art is too large. The maximum size is ${maxImageUploadMb} MB.`),
            { statusCode: 413 }
        );
    }

    const matchesSignature = allowedImageTypes.get(uploadFile.mimetype);
    if (!matchesSignature || !matchesSignature(uploadFile.buffer)) {
        throw Object.assign(
            new Error('Cover art must be a valid JPG, PNG, or WebP image.'),
            { statusCode: 400 }
        );
    }
};

export const uploadCoverArt = async (
    ownerType: ImageOwnerType,
    ownerId: string,
    uploadFile: Express.Multer.File,
    createdBy: string
) => {
    validateCoverArtFile(uploadFile);

    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    const s3Key = `images/${imageId}`;
    const now = new Date();

    await ImageAsset.insert({
        _id: imageObjectId,
        ownerType,
        ownerId,
        createdBy,
        originalFileName: normalizeUtf8Text(uploadFile.originalname),
        contentType: uploadFile.mimetype,
        s3Key,
        uploadStatus: 'pending',
        uploadUpdatedAt: now,
        uploadError: null
    });

    try {
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype,
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: {
                imageid: imageId,
                ownertype: ownerType,
                ownerid: ownerId,
                createdby: createdBy
            }
        }));
        await ImageAsset.updateById(imageId, {
            uploadStatus: 'ready',
            uploadUpdatedAt: new Date(),
            uploadError: null
        });
        return { imageId, coverArtUrl: coverArtUrlForId(imageId) };
    } catch (error) {
        await ImageAsset.updateById(imageId, {
            uploadStatus: 'failed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch(() => undefined);
        throw error;
    }
};

export const deleteCoverArt = async (imageId: string | undefined | null) => {
    if (!imageId) return;

    const asset = await ImageAsset.findById(imageId);
    if (!asset) {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: `images/${imageId}`
        }));
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

export const getCoverArtObject = async (imageId: string) => {
    const asset = await ImageAsset.findById(imageId);
    if (!asset || asset.uploadStatus !== 'ready') {
        return null;
    }

    const object = await getS3().send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: String(asset.s3Key)
    }));
    return { asset, object };
};
