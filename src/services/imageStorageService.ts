import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import { createReadStream, promises as fs } from 'node:fs';
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

const readImageSignature = async (uploadFile: Express.Multer.File) => {
    if (uploadFile.buffer) return uploadFile.buffer.subarray(0, 12);
    if (!uploadFile.path) return Buffer.alloc(0);
    const handle = await fs.open(uploadFile.path, 'r');
    try {
        const signature = new Uint8Array(12);
        const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
        return Buffer.from(signature.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
};

export const validateCoverArtFile = async (uploadFile: Express.Multer.File) => {
    const maxBytes = maxImageUploadMb * 1024 * 1024;
    if (uploadFile.size > maxBytes || (uploadFile.buffer?.length ?? 0) > maxBytes) {
        throw Object.assign(
            new Error(`Cover art is too large. The maximum size is ${maxImageUploadMb} MB.`),
            { statusCode: 413 }
        );
    }

    const signature = await readImageSignature(uploadFile);
    const matchesSignature = allowedImageTypes.get(uploadFile.mimetype);
    if (!matchesSignature || !matchesSignature(signature)) {
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
    await validateCoverArtFile(uploadFile);

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
        const body = uploadFile.path ? createReadStream(uploadFile.path) : uploadFile.buffer;
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key,
            Body: body,
            ContentLength: uploadFile.size,
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

export const getCoverArtObject = async (
    imageId: string,
    options: { ifNoneMatch?: string; abortSignal?: AbortSignal } = {}
) => {
    const asset = await ImageAsset.findById(imageId);
    if (!asset || asset.uploadStatus !== 'ready') {
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
