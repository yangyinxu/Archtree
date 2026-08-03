import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { getDb } from '../infrastructure/database';
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

const publicCoverArtOwnerTypes = new Set<ImageOwnerType>([
    'artist',
    'album',
    'audioTrack'
]);

export const coverArtVariantWidths = [96, 192, 320, 480, 640, 960, 1280] as const;
export type CoverArtVariantWidth = typeof coverArtVariantWidths[number];
export const maxCoverArtInputBytes = maxImageUploadMb * 1024 * 1024;
export const maxCoverArtInputPixels = 16_000_000;

const publicOwnerCollections = {
    artist: 'artists',
    album: 'albums',
    audioTrack: 'audioTracks'
} as const;

type PublicCoverArtAsset = Record<string, unknown> & {
    ownerType: Exclude<ImageOwnerType, 'user'>;
    uploadStatus: 'ready';
};

type CoverArtLookupDependencies = {
    findAsset?: (assetId: string) => Promise<unknown>;
    findOwner?: (asset: PublicCoverArtAsset) => Promise<unknown>;
};

type CoverArtObjectDependencies = CoverArtLookupDependencies & {
    getObject?: (input: {
        s3Key: string;
        ifNoneMatch?: string;
        abortSignal?: AbortSignal;
    }) => Promise<any>;
};

type CoverArtVariantDependencies = CoverArtLookupDependencies & {
    getObject?: (input: {
        s3Key: string;
        abortSignal?: AbortSignal;
    }) => Promise<any>;
    transform?: (input: Buffer, width: CoverArtVariantWidth) => Promise<Buffer>;
    maxInputBytes?: number;
    attachSource?: (source: Readable) => void;
    schedule?: CoverArtVariantScheduler;
};

export type CoverArtVariantScheduler = <T>(
    clientKey: string,
    abortSignal: AbortSignal | undefined,
    operation: () => Promise<T>
) => Promise<T>;

type PendingCoverArtWork<T> = {
    clientKey: string;
    abortSignal?: AbortSignal;
    operation: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    abortQueued: () => void;
};

const abortError = () => Object.assign(
    new Error('Cover-art request was aborted.'),
    { name: 'AbortError' }
);

/** Queues bounded derivative work so a normal artwork burst waits instead of returning 429. */
export const createCoverArtVariantScheduler = (
    perClientLimit = 2,
    globalLimit = 4,
    maximumQueued = 128,
    maximumQueuedPerClient = Math.min(32, maximumQueued)
): CoverArtVariantScheduler => {
    if (![perClientLimit, globalLimit, maximumQueued, maximumQueuedPerClient].every(
        (value) => Number.isInteger(value) && value > 0
    ) || perClientLimit > globalLimit || maximumQueuedPerClient > maximumQueued) {
        throw new Error('Cover-art scheduler limits are invalid.');
    }

    let activeGlobal = 0;
    const activeByClient = new Map<string, number>();
    const pendingByClient = new Map<string, PendingCoverArtWork<unknown>[]>();
    const readyClients: string[] = [];
    let pendingCount = 0;

    const removeReadyClient = (clientKey: string) => {
        const index = readyClients.indexOf(clientKey);
        if (index >= 0) readyClients.splice(index, 1);
    };

    const takeNextTask = () => {
        const clientsToCheck = readyClients.length;
        for (let index = 0; index < clientsToCheck; index += 1) {
            const clientKey = readyClients.shift()!;
            const clientQueue = pendingByClient.get(clientKey);
            if (!clientQueue?.length) {
                pendingByClient.delete(clientKey);
                continue;
            }
            if ((activeByClient.get(clientKey) ?? 0) >= perClientLimit) {
                readyClients.push(clientKey);
                continue;
            }

            const task = clientQueue.shift()!;
            pendingCount -= 1;
            if (clientQueue.length > 0) readyClients.push(clientKey);
            else pendingByClient.delete(clientKey);
            return task;
        }
        return undefined;
    };

    const dispatch = () => {
        while (activeGlobal < globalLimit) {
            const task = takeNextTask();
            if (!task) return;
            task.abortSignal?.removeEventListener('abort', task.abortQueued);
            if (task.abortSignal?.aborted) {
                task.reject(abortError());
                continue;
            }

            activeGlobal += 1;
            activeByClient.set(task.clientKey, (activeByClient.get(task.clientKey) ?? 0) + 1);
            Promise.resolve()
                .then(task.operation)
                .then(task.resolve, task.reject)
                .finally(() => {
                    activeGlobal -= 1;
                    const clientActive = (activeByClient.get(task.clientKey) ?? 1) - 1;
                    if (clientActive <= 0) activeByClient.delete(task.clientKey);
                    else activeByClient.set(task.clientKey, clientActive);
                    dispatch();
                });
        }
    };

    return <T>(clientKey: string, abortSignal: AbortSignal | undefined, operation: () => Promise<T>) => {
        if (abortSignal?.aborted) return Promise.reject(abortError());
        const normalizedClientKey = String(clientKey || 'unknown').slice(0, 128);
        const canStartImmediately = activeGlobal < globalLimit
            && (activeByClient.get(normalizedClientKey) ?? 0) < perClientLimit;
        const queuedForClient = pendingByClient.get(normalizedClientKey)?.length ?? 0;
        if (!canStartImmediately && (
            pendingCount >= maximumQueued
            || queuedForClient >= maximumQueuedPerClient
        )) {
            return Promise.reject(Object.assign(
                new Error('Cover-art derivative queue is full.'),
                { statusCode: 503 }
            ));
        }

        return new Promise<T>((resolve, reject) => {
            const task: PendingCoverArtWork<T> = {
                clientKey: normalizedClientKey,
                abortSignal,
                operation,
                resolve,
                reject,
                abortQueued: () => {
                    const clientQueue = pendingByClient.get(normalizedClientKey);
                    const index = clientQueue?.indexOf(task as PendingCoverArtWork<unknown>) ?? -1;
                    if (index < 0) return;
                    clientQueue!.splice(index, 1);
                    pendingCount -= 1;
                    if (clientQueue!.length === 0) {
                        pendingByClient.delete(normalizedClientKey);
                        removeReadyClient(normalizedClientKey);
                    }
                    abortSignal?.removeEventListener('abort', task.abortQueued);
                    reject(abortError());
                }
            };
            const clientQueue = pendingByClient.get(normalizedClientKey);
            if (clientQueue) clientQueue.push(task as PendingCoverArtWork<unknown>);
            else {
                pendingByClient.set(normalizedClientKey, [task as PendingCoverArtWork<unknown>]);
                readyClients.push(normalizedClientKey);
            }
            pendingCount += 1;
            abortSignal?.addEventListener('abort', task.abortQueued, { once: true });
            dispatch();
        });
    };
};

const scheduleCoverArtVariant = createCoverArtVariantScheduler();

/** Keeps account-owned avatar bytes out of the public cover-art resolver. */
export const isPublicCoverArtAsset = (asset: unknown): asset is PublicCoverArtAsset => {
    if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) return false;
    const candidate = asset as Record<string, unknown>;
    return candidate.uploadStatus === 'ready'
        && publicCoverArtOwnerTypes.has(candidate.ownerType as ImageOwnerType);
};

/** Restricts derivative cache keys and Sharp work to the reviewed width set. */
export const isCoverArtVariantWidth = (value: unknown): boolean => {
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    const width = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'string' && value !== String(width)) return false;
    return Number.isInteger(width)
        && coverArtVariantWidths.includes(width as CoverArtVariantWidth);
};

/** Gives each immutable transformation contract its own HTTP representation tag. */
export const coverArtVariantEtag = (
    imageId: string,
    width: CoverArtVariantWidth
) => `"cover-art-${imageId.toLowerCase()}-v1-${width}"`;

const etagMatches = (ifNoneMatch: string | undefined, currentEtag: string) => {
    if (!ifNoneMatch) return false;
    return ifNoneMatch.split(',').some((candidate) => {
        const normalized = candidate.trim();
        return normalized === '*'
            || normalized === currentEtag
            || normalized === `W/${currentEtag}`;
    });
};

const findPublicCoverArtOwner = async (asset: PublicCoverArtAsset) => {
    const ownerType = asset.ownerType as keyof typeof publicOwnerCollections;
    const ownerId = String(asset.ownerId ?? '');
    if (!/^[0-9a-f]{24}$/i.test(ownerId)) return null;
    return getDb()!.collection(publicOwnerCollections[ownerType]).findOne(
        { _id: ObjectId.createFromHexString(ownerId) },
        { projection: { coverArtId: 1 } }
    );
};

/** Resolves only an attached, ready catalog asset; detached assets are never public. */
export const resolvePublicCoverArtAsset = async (
    imageId: string,
    dependencies: CoverArtLookupDependencies = {}
): Promise<PublicCoverArtAsset | null> => {
    const findAsset = dependencies.findAsset ?? ImageAsset.findById.bind(ImageAsset);
    const asset = await findAsset(imageId);
    if (!isPublicCoverArtAsset(asset)) return null;

    const findOwner = dependencies.findOwner ?? findPublicCoverArtOwner;
    const owner = await findOwner(asset);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
    const attachedImageId = String((owner as Record<string, unknown>).coverArtId ?? '');
    return attachedImageId.toLowerCase() === imageId.toLowerCase() ? asset : null;
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
    if (uploadFile.size > maxCoverArtInputBytes
        || (uploadFile.buffer?.length ?? 0) > maxCoverArtInputBytes) {
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

    try {
        const input = uploadFile.path || uploadFile.buffer;
        const decodeOptions = {
            failOn: 'error' as const,
            limitInputPixels: maxCoverArtInputPixels,
            sequentialRead: true
        };
        const metadata = await sharp(input, decodeOptions).metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (!width || !height || width * height > maxCoverArtInputPixels) {
            throw new Error('Image dimensions are missing or exceed the pixel limit.');
        }
        // Metadata parsing alone can accept truncated files; force a bounded full decode.
        await sharp(input, decodeOptions)
            .rotate()
            .resize(1, 1, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
    } catch {
        throw Object.assign(
            new Error('Cover art must be a decodable JPG, PNG, or WebP image within the pixel limit.'),
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
    options: { ifNoneMatch?: string; abortSignal?: AbortSignal } = {},
    dependencies: CoverArtObjectDependencies = {}
) => {
    const asset = await resolvePublicCoverArtAsset(imageId, dependencies);
    if (!asset) return null;

    try {
        const object = await (dependencies.getObject
            ? dependencies.getObject({
                s3Key: String(asset.s3Key),
                ifNoneMatch: options.ifNoneMatch,
                abortSignal: options.abortSignal
            })
            : getS3().send(new GetObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: String(asset.s3Key),
                IfNoneMatch: options.ifNoneMatch
            }), { abortSignal: options.abortSignal }));
        return { asset, object, notModified: false as const };
    } catch (error: any) {
        if (error?.$metadata?.httpStatusCode === 304) {
            const responseEtagValue = error?.$response?.headers?.etag;
            const responseEtag = String(
                Array.isArray(responseEtagValue) ? responseEtagValue[0] : responseEtagValue ?? ''
            ).trim();
            const etag = /^(?:W\/)?"[^"\r\n]+"$/.test(responseEtag)
                ? responseEtag
                : undefined;
            return { asset, etag, notModified: true as const };
        }
        throw error;
    }
};

const boundedImageBody = async (
    stream: Readable,
    maximumBytes: number,
    abortSignal?: AbortSignal
) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
        if (abortSignal?.aborted) {
            stream.destroy();
            throw abortError();
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maximumBytes) {
            stream.destroy();
            throw Object.assign(
                new Error('Stored cover art exceeds the derivative input limit.'),
                { statusCode: 413 }
            );
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, totalBytes);
};

/** Produces a deterministic square derivative while stripping source metadata. */
export const transformCoverArtVariant = async (
    input: Buffer,
    width: CoverArtVariantWidth,
    options: { maxInputPixels?: number } = {}
) => sharp(input, {
    failOn: 'error',
    limitInputPixels: options.maxInputPixels ?? maxCoverArtInputPixels
})
    .rotate()
    .resize(width, width, {
        fit: 'cover',
        position: 'centre'
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

export type CoverArtVariantResult = {
    asset: PublicCoverArtAsset;
    body?: Buffer;
    etag: string;
    notModified: boolean;
};

/** Resolves, conditionally validates, and transforms one fixed-width v1 representation. */
export const getCoverArtVariant = async (
    imageId: string,
    widthValue: unknown,
    options: { ifNoneMatch?: string; abortSignal?: AbortSignal; clientKey?: string } = {},
    dependencies: CoverArtVariantDependencies = {}
): Promise<CoverArtVariantResult | null> => {
    if (!isCoverArtVariantWidth(widthValue)) {
        throw Object.assign(new Error('Unsupported cover-art width.'), { statusCode: 400 });
    }
    const width = Number(widthValue) as CoverArtVariantWidth;
    const schedule = dependencies.schedule ?? scheduleCoverArtVariant;
    return schedule(options.clientKey ?? 'unknown', options.abortSignal, async () => {
        const asset = await resolvePublicCoverArtAsset(imageId, dependencies);
        if (options.abortSignal?.aborted) throw abortError();
        if (!asset) return null;

        const etag = coverArtVariantEtag(imageId, width);
        if (etagMatches(options.ifNoneMatch, etag)) {
            return { asset, etag, notModified: true };
        }

        const object = await (dependencies.getObject
            ? dependencies.getObject({
                s3Key: String(asset.s3Key),
                abortSignal: options.abortSignal
            })
            : getS3().send(new GetObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: String(asset.s3Key)
            }), { abortSignal: options.abortSignal }));
        const stream = object.Body as unknown as Readable | undefined;
        if (!stream || typeof stream.pipe !== 'function') {
            throw new Error('S3 image body is not a readable stream.');
        }
        dependencies.attachSource?.(stream);

        const requestedInputLimit = Number(dependencies.maxInputBytes ?? maxCoverArtInputBytes);
        const maximumInputBytes = Number.isFinite(requestedInputLimit) && requestedInputLimit > 0
            ? Math.min(Math.floor(requestedInputLimit), maxCoverArtInputBytes)
            : maxCoverArtInputBytes;
        const declaredLength = Number(object.ContentLength);
        if (Number.isFinite(declaredLength) && declaredLength > maximumInputBytes) {
            stream.destroy();
            throw Object.assign(
                new Error('Stored cover art exceeds the derivative input limit.'),
                { statusCode: 413 }
            );
        }
        const input = await boundedImageBody(stream, maximumInputBytes, options.abortSignal);
        const transform = dependencies.transform ?? transformCoverArtVariant;
        const body = await transform(input, width);
        if (options.abortSignal?.aborted) throw abortError();
        return { asset, body, etag, notModified: false };
    });
};
