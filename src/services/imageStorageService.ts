import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { ClientSession, ObjectId } from 'mongodb';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import {
    ImageAsset,
    ImageAssetRecord,
    ImageOwnerType
} from '../models/imageAsset';
import { maxImageUploadMb } from '../middleware/imageUpload';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { coverArtUrlForId } from '../utils/coverArt';
import {
    readyArtistLifecycleFilter,
    touchReadyArtistReferences
} from './artistReferenceFenceService';
import {
    isReadyAlbumLifecycle,
    readyAlbumLifecycleFilter,
    touchReadyAlbumReferences
} from './albumReferenceFenceService';
import {
    isAudioObjectKeyForTrack,
    readyAudioStorageFilter
} from '../utils/audioStorageKey';

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
const canonicalOwnerId = (value: string) => /^[0-9a-fA-F]{24}$/.test(value)
    ? ObjectId.createFromHexString(value).toHexString()
    : value;

export const coverArtVariantWidths = [96, 192, 320, 480, 640, 960, 1280] as const;
export type CoverArtVariantWidth = typeof coverArtVariantWidths[number];
export const maxCoverArtInputBytes = maxImageUploadMb * 1024 * 1024;
export const maxCoverArtInputPixels = 16_000_000;
const maximumOwnerCoverArtAssets = 1_000;

export interface CoverArtUploadOptions {
    /** New Artist/Album owners may upload before their one-step publication insert. */
    allowMissingOwner?: boolean;
}

const coverArtLifecycleWriteMayHaveCommitted = (error: any) =>
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

const comparableOwnerValue = (value: any): any => {
    if (value instanceof ObjectId) return value.toHexString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(comparableOwnerValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [
            key,
            comparableOwnerValue(value[key])
        ]));
    }
    return value;
};

const ownerFieldsMatchUpdate = (owner: any, update: Record<string, unknown>) =>
    Object.entries(update).every(([field, expected]) =>
        JSON.stringify(comparableOwnerValue(owner?.[field]))
        === JSON.stringify(comparableOwnerValue(expected))
    );

export class CoverArtUploadOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'cover_art_upload_outcome_unknown';
    readonly cleanupPending = true;
    readonly reconciliationRequired = true;
    readonly outcomeUnknown = true;
    readonly cause: unknown;

    constructor(imageId: string, cause: unknown) {
        super(`Cover-art upload ${imageId} outcome could not be confirmed.`);
        this.cause = cause;
    }
}

const exactCoverArtAsset = (
    asset: any,
    expected: ImageAssetRecord,
    uploadStatus: ImageAssetRecord['uploadStatus']
) => asset
    && asset.uploadStatus === uploadStatus
    && asset.ownerType === expected.ownerType
    && canonicalOwnerId(String(asset.ownerId ?? '')) === canonicalOwnerId(expected.ownerId)
    && String(asset.s3Key ?? '') === expected.s3Key
    && String(asset.createdBy ?? '') === expected.createdBy;

const touchCoverArtOwner = async (asset: ImageAssetRecord, session: ClientSession) => {
    const normalizedOwnerId = canonicalOwnerId(asset.ownerId);
    if (asset.ownerType === 'artist') {
        await touchReadyArtistReferences([normalizedOwnerId], session);
    } else if (asset.ownerType === 'album') {
        await touchReadyAlbumReferences([normalizedOwnerId], session);
    } else if (asset.ownerType === 'audioTrack') {
        const touched = await getDb()!.collection('audioTracks').updateOne(
            {
                _id: ObjectId.createFromHexString(normalizedOwnerId),
                uploadStatus: { $nin: ['deleting', 'deleteFailed'] }
            },
            { $inc: { coverArtReferenceRevision: 1 } },
            { session }
        );
        if (touched.matchedCount !== 1) {
            throw Object.assign(new Error('The Soundtrack is unavailable for artwork.'), {
                statusCode: 409,
                code: 'audio_track_mutation_unavailable'
            });
        }
    } else {
        throw new Error('Use the private avatar lifecycle for user images.');
    }
};

const withCoverArtOwnerFence = async <T>(
    asset: ImageAssetRecord,
    options: CoverArtUploadOptions,
    mutation: (session?: ClientSession) => Promise<T>
) => {
    if (options.allowMissingOwner) {
        if (asset.ownerType !== 'artist' && asset.ownerType !== 'album') {
            throw new Error('Only a new Artist or Album may stage artwork before owner creation.');
        }
        return mutation();
    }

    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            await touchCoverArtOwner(asset, session);
            result = await mutation(session);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};

export interface CoverArtUploadStagingDependencies {
    runWithOwnerFence: typeof withCoverArtOwnerFence;
    insertAsset: (asset: ImageAssetRecord, session?: ClientSession) => Promise<unknown>;
    findAsset: (imageId: string) => Promise<any | null>;
}

const defaultCoverArtUploadStagingDependencies: CoverArtUploadStagingDependencies = {
    runWithOwnerFence: withCoverArtOwnerFence,
    insertAsset: (asset, session) => ImageAsset.insert(asset, session),
    findAsset: ImageAsset.findById.bind(ImageAsset)
};

/** Records a pending asset and confirms any lost transaction response before S3 Put. */
export const stageCoverArtLifecycleRecord = async (
    asset: ImageAssetRecord,
    options: CoverArtUploadOptions = {},
    dependencies: Partial<CoverArtUploadStagingDependencies> = {}
) => {
    const staging = { ...defaultCoverArtUploadStagingDependencies, ...dependencies };
    try {
        return await staging.runWithOwnerFence(
            asset,
            options,
            (session) => staging.insertAsset(asset, session)
        );
    } catch (writeError) {
        if (!coverArtLifecycleWriteMayHaveCommitted(writeError)) throw writeError;
        let observed: any | null;
        try {
            observed = await staging.findAsset(asset._id.toHexString());
        } catch (confirmationError) {
            throw new CoverArtUploadOutcomeUnknownError(asset._id.toHexString(), {
                writeError,
                confirmationError
            });
        }
        if (exactCoverArtAsset(observed, asset, 'pending')) return;
        throw new CoverArtUploadOutcomeUnknownError(asset._id.toHexString(), { writeError });
    }
};

export interface CoverArtUploadFinalizationDependencies {
    runWithOwnerFence: <T>(
        asset: ImageAssetRecord,
        options: CoverArtUploadOptions,
        mutation: (session?: ClientSession) => Promise<T>
    ) => Promise<T>;
    updatePendingAsset: (
        asset: ImageAssetRecord,
        update: Record<string, unknown>,
        session?: ClientSession
    ) => Promise<{ matchedCount: number }>;
    findAsset: (imageId: string) => Promise<any | null>;
}

/** Isolates external upload steps while keeping the production lifecycle orchestration testable. */
export interface CoverArtUploadOrchestrationDependencies {
    stageAsset: (
        asset: ImageAssetRecord,
        options: CoverArtUploadOptions
    ) => Promise<unknown>;
    putObject: (
        asset: ImageAssetRecord,
        uploadFile: Express.Multer.File
    ) => Promise<void>;
    finalizeAsset: (
        asset: ImageAssetRecord,
        options: CoverArtUploadOptions
    ) => Promise<void>;
    deleteObject: (s3Key: string) => Promise<void>;
    markFailedAsset: (
        asset: ImageAssetRecord,
        error: unknown
    ) => Promise<unknown>;
}

type CoverArtConditionalUpdater = (
    imageId: string,
    expected: Record<string, unknown>,
    update: Record<string, unknown>
) => Promise<{ matchedCount: number }>;

/** Records a failed Put/finalization only while the exact staged lease is still pending. */
export const markStagedCoverArtUploadFailed = (
    asset: ImageAssetRecord,
    failure: unknown,
    updateAsset: CoverArtConditionalUpdater = (imageId, expected, update) =>
        ImageAsset.updateByIdWhere(imageId, expected, update)
) => updateAsset(
    asset._id.toHexString(),
    {
        ownerType: asset.ownerType,
        ownerId: asset.ownerId,
        s3Key: asset.s3Key,
        createdBy: asset.createdBy,
        uploadStatus: 'pending'
    },
    {
        uploadStatus: 'failed',
        uploadUpdatedAt: new Date(),
        uploadError: errorMessage(failure)
    }
);

const defaultCoverArtUploadFinalizationDependencies: CoverArtUploadFinalizationDependencies = {
    runWithOwnerFence: withCoverArtOwnerFence,
    updatePendingAsset: (asset, update, session) => ImageAsset.updateByIdWhere(
        asset._id.toHexString(),
        {
            ownerType: asset.ownerType,
            ownerId: canonicalOwnerId(asset.ownerId),
            s3Key: asset.s3Key,
            createdBy: asset.createdBy,
            uploadStatus: 'pending'
        },
        update,
        session
    ),
    findAsset: ImageAsset.findById.bind(ImageAsset)
};

/** Commits pending→ready only while the owner is still mutation-ready. */
export const finalizeStagedCoverArtLifecycleRecord = async (
    asset: ImageAssetRecord,
    options: CoverArtUploadOptions = {},
    dependencies: Partial<CoverArtUploadFinalizationDependencies> = {}
) => {
    const finalization = {
        ...defaultCoverArtUploadFinalizationDependencies,
        ...dependencies
    };
    try {
        await finalization.runWithOwnerFence(asset, options, async (session) => {
            const result = await finalization.updatePendingAsset(asset, {
                uploadStatus: 'ready',
                uploadUpdatedAt: new Date(),
                uploadError: null
            }, session);
            if (result.matchedCount !== 1) {
                throw new Error(`Cover-art lifecycle record ${asset._id.toHexString()} could not be finalized.`);
            }
        });
        return;
    } catch (writeError) {
        let observed: any | null;
        try {
            observed = await finalization.findAsset(asset._id.toHexString());
        } catch (confirmationError) {
            throw new CoverArtUploadOutcomeUnknownError(asset._id.toHexString(), {
                writeError,
                confirmationError
            });
        }
        if (exactCoverArtAsset(observed, asset, 'ready')) return;
        if (coverArtLifecycleWriteMayHaveCommitted(writeError)) {
            throw new CoverArtUploadOutcomeUnknownError(asset._id.toHexString(), { writeError });
        }
        throw writeError;
    }
};

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

/** Isolates cover-art deletion boundaries for deterministic failure and retry handling. */
export interface CoverArtDeletionDependencies {
    expectedOwnerType?: Exclude<ImageOwnerType, 'user'>;
    expectedOwnerId?: string;
    findAsset: (imageId: string) => Promise<any | null>;
    updateAsset: (
        imageId: string,
        update: Record<string, unknown>,
        expected?: Record<string, unknown>
    ) => Promise<unknown>;
    deleteObject: (s3Key: string) => Promise<void>;
    deleteAsset: (imageId: string) => Promise<unknown>;
}

/** Applies an owner mutation before cleaning up artwork that is no longer attached. */
export interface CoverArtOwnerUpdateDependencies {
    ownerType: Exclude<ImageOwnerType, 'user'>;
    updateOwner: (ownerId: string, update: Record<string, unknown>) => Promise<unknown>;
    updateOwnerIfCoverArtMatches?: (
        ownerId: string,
        expectedImageId: string | undefined | null,
        update: Record<string, unknown>
    ) => Promise<unknown>;
    findOwner?: (ownerId: string) => Promise<any | null>;
    deleteAsset?: (imageId: string) => Promise<void>;
    deleteReplacementAsset?: (imageId: string) => Promise<void>;
    verifyPreviousAsset?: (imageId: string, ownerId: string) => Promise<boolean>;
}

/** Keeps an image lifecycle record until its owning entity has been deleted. */
export interface CoverArtOwnerDeletionDependencies {
    prepareAssetDeletion?: (imageId: string | undefined | null) => Promise<boolean>;
    finalizeAssetDeletion?: (imageId: string | undefined | null) => Promise<void>;
}

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

/** Binds every public cover-art record to its immutable image identity. */
export const isCoverArtObjectKeyForImage = (value: unknown, imageId: string) => {
    const normalizedImageId = imageId.toLowerCase();
    return /^[0-9a-f]{24}$/.test(normalizedImageId)
        && typeof value === 'string'
        && value === `images/${normalizedImageId}`;
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
    const lifecycleFilter = ownerType === 'artist'
        ? readyArtistLifecycleFilter
        : ownerType === 'album'
            ? readyAlbumLifecycleFilter
            : readyAudioStorageFilter;
    return getDb()!.collection(publicOwnerCollections[ownerType]).findOne(
        { _id: ObjectId.createFromHexString(ownerId), ...lifecycleFilter },
        {
            projection: {
                coverArtId: 1,
                lifecycleStatus: 1,
                uploadStatus: 1,
                s3Key: 1
            }
        }
    );
};

/** Rechecks injected owner lookups so tests and alternate stores cannot bypass readiness. */
export const isPublicCoverArtOwnerReady = (
    asset: PublicCoverArtAsset,
    owner: Record<string, unknown>
) => {
    if (asset.ownerType === 'artist') {
        return owner.lifecycleStatus === undefined || owner.lifecycleStatus === 'ready';
    }
    if (asset.ownerType === 'album') return isReadyAlbumLifecycle(owner);
    const ownerId = String(asset.ownerId ?? '').toLowerCase();
    const hasPublicationStatus = Object.prototype.hasOwnProperty.call(
        owner,
        'publicationStatus'
    );
    return owner.uploadStatus === 'ready'
        && (!hasPublicationStatus || owner.publicationStatus === 'ready')
        && isAudioObjectKeyForTrack(owner.s3Key, ownerId);
};

/** Resolves only an attached, ready catalog asset; detached assets are never public. */
export const resolvePublicCoverArtAsset = async (
    imageId: string,
    dependencies: CoverArtLookupDependencies = {}
): Promise<PublicCoverArtAsset | null> => {
    const findAsset = dependencies.findAsset ?? ImageAsset.findById.bind(ImageAsset);
    const asset = await findAsset(imageId);
    if (!isPublicCoverArtAsset(asset)) return null;
    if (!isCoverArtObjectKeyForImage(asset.s3Key, imageId)) return null;

    const findOwner = dependencies.findOwner ?? findPublicCoverArtOwner;
    const owner = await findOwner(asset);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
    if (!isPublicCoverArtOwnerReady(asset, owner as Record<string, unknown>)) return null;
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
    createdBy: string,
    options: CoverArtUploadOptions = {},
    dependencies: Partial<CoverArtUploadOrchestrationDependencies> = {}
) => {
    await validateCoverArtFile(uploadFile);
    const normalizedOwnerId = canonicalOwnerId(ownerId);

    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    const s3Key = `images/${imageId}`;
    const now = new Date();

    const asset: ImageAssetRecord = {
        _id: imageObjectId,
        ownerType,
        ownerId: normalizedOwnerId,
        createdBy,
        originalFileName: normalizeUtf8Text(uploadFile.originalname),
        contentType: uploadFile.mimetype,
        s3Key,
        uploadStatus: 'pending',
        uploadUpdatedAt: now,
        uploadError: null
    };

    const orchestration: CoverArtUploadOrchestrationDependencies = {
        stageAsset: stageCoverArtLifecycleRecord,
        putObject: async (stagedAsset, file) => {
            const body = file.path ? createReadStream(file.path) : file.buffer;
            await getS3().send(new PutObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: stagedAsset.s3Key,
                Body: body,
                ContentLength: file.size,
                ContentType: file.mimetype,
                CacheControl: 'public, max-age=31536000, immutable',
                Metadata: {
                    imageid: stagedAsset._id.toHexString(),
                    ownertype: stagedAsset.ownerType,
                    ownerid: stagedAsset.ownerId,
                    createdby: stagedAsset.createdBy
                }
            }));
        },
        finalizeAsset: finalizeStagedCoverArtLifecycleRecord,
        deleteObject: async (key) => {
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: key
            }));
        },
        markFailedAsset: markStagedCoverArtUploadFailed,
        ...dependencies
    };

    await orchestration.stageAsset(asset, options);

    let objectStored = false;
    try {
        await orchestration.putObject(asset, uploadFile);
        objectStored = true;
        await orchestration.finalizeAsset(asset, options);
        return { imageId, coverArtUrl: coverArtUrlForId(imageId) };
    } catch (error) {
        // An unknown commit must retain both exact object and lifecycle evidence for reconciliation.
        if (objectStored && error instanceof CoverArtUploadOutcomeUnknownError) throw error;

        let cleanupError: unknown;
        if (objectStored) {
            try {
                await orchestration.deleteObject(s3Key);
            } catch (deleteError) {
                cleanupError = deleteError;
            }
        }

        await orchestration.markFailedAsset(asset, cleanupError ?? error).catch(() => undefined);

        if (cleanupError) {
            throw Object.assign(
                new Error('Cover-art upload could not be published and storage cleanup requires reconciliation.'),
                {
                    statusCode: 503,
                    code: 'cover_art_upload_cleanup_pending',
                    cleanupPending: true,
                    reconciliationRequired: true,
                    cause: { publicationError: error, cleanupError }
                }
            );
        }
        throw error;
    }
};

const defaultCoverArtDeletionDependencies: CoverArtDeletionDependencies = {
    findAsset: imageId => ImageAsset.findById(imageId),
    updateAsset: (imageId, update, expected = {}) => ImageAsset.updateByIdWhere(
        imageId,
        expected,
        update
    ),
    deleteObject: async s3Key => {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key
        }));
    },
    deleteAsset: imageId => ImageAsset.deleteByIdWhere(imageId, { uploadStatus: 'deleting' })
};

/*
 * The lifecycle record is deliberately retained on every failed transition.
 * Owner deletion can then retry the exact recorded key without guessing.
 */
const markCoverArtDeletionFailed = async (
    deletion: CoverArtDeletionDependencies,
    imageId: string,
    asset: any,
    error: unknown
) => {
    await deletion.updateAsset(imageId, {
        uploadStatus: 'deleteFailed',
        uploadUpdatedAt: new Date(),
        uploadError: errorMessage(error)
    }, {
        ownerType: asset.ownerType,
        ownerId: asset.ownerId,
        s3Key: asset.s3Key,
        uploadStatus: 'deleting'
    }).catch(() => undefined);
};

const validatedCoverArtObjectKey = (
    asset: any,
    imageId: string,
    expectedOwnerType?: Exclude<ImageOwnerType, 'user'>,
    expectedOwnerId?: string
) => {
    const s3Key = String(asset?.s3Key ?? '');
    if (!publicCoverArtOwnerTypes.has(asset?.ownerType as ImageOwnerType)
        || (expectedOwnerType !== undefined && asset?.ownerType !== expectedOwnerType)
        || (expectedOwnerId !== undefined && String(asset?.ownerId ?? '') !== expectedOwnerId)
        || !isCoverArtObjectKeyForImage(s3Key, imageId)) {
        throw new Error('Cover-art storage key is missing or invalid.');
    }
    return s3Key;
};

/** Deletes the recorded S3 object while retaining lifecycle evidence for owner deletion. */
export const prepareCoverArtDeletion = async (
    imageId: string | undefined | null,
    dependencies: Partial<CoverArtDeletionDependencies> = {}
) => {
    if (!imageId) return false;
    const deletion = { ...defaultCoverArtDeletionDependencies, ...dependencies };
    const asset = await deletion.findAsset(imageId);
    // Missing lifecycle evidence never authorizes a guessed object-key deletion.
    if (!asset) return false;
    // Validate both namespace and ownership before changing another record's state.
    const s3Key = validatedCoverArtObjectKey(
        asset,
        imageId,
        deletion.expectedOwnerType,
        deletion.expectedOwnerId
    );

    // A pending Put owns this record. Retain the owner until the uploader either
    // commits ready behind the owner fence or records an auditable failure.
    if (asset.uploadStatus === 'pending') {
        throw Object.assign(new Error('Cover-art upload is still in progress.'), {
            statusCode: 409,
            code: 'cover_art_upload_in_progress'
        });
    }

    const observedStatus = asset.uploadStatus === undefined
        ? { $exists: false }
        : asset.uploadStatus;

    const deletingUpdate = await deletion.updateAsset(imageId, {
        uploadStatus: 'deleting',
        uploadUpdatedAt: new Date(),
        uploadError: null
    }, {
        ownerType: asset.ownerType,
        ownerId: asset.ownerId,
        s3Key: asset.s3Key,
        uploadStatus: observedStatus
    });
    if (deletingUpdate && typeof deletingUpdate === 'object'
        && 'matchedCount' in deletingUpdate
        && Number((deletingUpdate as { matchedCount: unknown }).matchedCount) !== 1) {
        throw new Error(`Cover-art lifecycle record ${imageId} could not be prepared.`);
    }

    try {
        await deletion.deleteObject(s3Key);
        return true;
    } catch (error) {
        await markCoverArtDeletionFailed(deletion, imageId, asset, error);
        throw error;
    }
};

/** Removes lifecycle evidence only after every database owner reference is gone. */
export const finalizeCoverArtDeletion = async (
    imageId: string | undefined | null,
    dependencies: Partial<CoverArtDeletionDependencies> = {}
) => {
    if (!imageId) return;
    const deletion = { ...defaultCoverArtDeletionDependencies, ...dependencies };
    const deleted = await deletion.deleteAsset(imageId);
    if (deleted && typeof deleted === 'object'
        && 'deletedCount' in deleted
        && Number((deleted as { deletedCount: unknown }).deletedCount) !== 1) {
        throw new Error(`Cover-art lifecycle record ${imageId} could not be finalized.`);
    }
};

/** Deletes detached or replaced cover art through its recorded lifecycle key. */
export const deleteCoverArt = async (
    imageId: string | undefined | null,
    dependencies: Partial<CoverArtDeletionDependencies> = {}
) => {
    const prepared = await prepareCoverArtDeletion(imageId, dependencies);
    if (prepared) await finalizeCoverArtDeletion(imageId, dependencies);
};

const ownerIdCandidates = (ownerId: string) => {
    const normalizedOwnerId = canonicalOwnerId(ownerId);
    const values: Array<string | ObjectId> = [normalizedOwnerId];
    if (ObjectId.isValid(normalizedOwnerId)) {
        values.push(ObjectId.createFromHexString(normalizedOwnerId));
    }
    if (ownerId !== normalizedOwnerId) values.push(ownerId);
    return [...new Set(values as any[])];
};

/** Deletes every current or detached asset object before its catalog owner disappears. */
export const prepareOwnerCoverArtDeletions = async (
    ownerType: Exclude<ImageOwnerType, 'user'>,
    ownerId: string,
    currentImageId?: string | null,
    dependencies: Partial<CoverArtDeletionDependencies> & {
        findAssets?: (
            ownerType: Exclude<ImageOwnerType, 'user'>,
            ownerIds: Array<string | ObjectId>,
            limit: number
        ) => Promise<any[]>;
    } = {}
) => {
    const normalizedOwnerId = canonicalOwnerId(ownerId);
    const candidates = ownerIdCandidates(ownerId);
    const assets = dependencies.findAssets
        ? await dependencies.findAssets(ownerType, candidates, maximumOwnerCoverArtAssets + 1)
        : await getDb()!.collection('imageAssets').find({
            ownerType,
            ownerId: { $in: candidates }
        }).project({ _id: 1 }).sort({ _id: 1 }).limit(maximumOwnerCoverArtAssets + 1).toArray();
    if (assets.length > maximumOwnerCoverArtAssets) {
        throw new Error(`The ${ownerType} has too many artwork lifecycle records to delete safely.`);
    }
    const imageIds = [...new Set(assets.map((asset) => String(asset._id).toLowerCase()))];
    const expectedCurrentId = String(currentImageId ?? '').trim().toLowerCase();
    if (expectedCurrentId && !imageIds.includes(expectedCurrentId)) {
        throw new Error('Cover-art lifecycle evidence is missing.');
    }
    for (const imageId of imageIds) {
        const prepared = await prepareCoverArtDeletion(imageId, {
            ...dependencies,
            expectedOwnerType: ownerType,
            expectedOwnerId: normalizedOwnerId
        });
        if (!prepared) throw new Error('Cover-art lifecycle evidence is missing.');
    }
    return imageIds;
};

/** Removes every prepared lifecycle record after its owner deletion is confirmed. */
export const finalizeOwnerCoverArtDeletions = async (
    imageIds: readonly string[],
    dependencies: Partial<CoverArtDeletionDependencies> = {}
) => {
    const failures: unknown[] = [];
    for (const imageId of imageIds) {
        try {
            await finalizeCoverArtDeletion(imageId, dependencies);
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw Object.assign(new Error('One or more cover-art lifecycle records could not be finalized.'), {
            cause: failures
        });
    }
};

/** Persists the new owner reference before attempting idempotent old-asset cleanup. */
export const updateCoverArtOwnerAndCleanup = async (
    ownerId: string,
    update: Record<string, unknown>,
    previousImageId: string | undefined | null,
    shouldDeletePrevious: boolean,
    dependencies: CoverArtOwnerUpdateDependencies
) => {
    const normalizedOwnerId = canonicalOwnerId(ownerId);
    const replacementImageId = typeof update.coverArtId === 'string'
        ? String(update.coverArtId)
        : undefined;
    const deleteReplacement = async () => {
        if (!replacementImageId) return { cleanupPending: false };
        try {
            if (dependencies.deleteReplacementAsset) {
                await dependencies.deleteReplacementAsset(replacementImageId);
            } else {
                await deleteCoverArt(replacementImageId, {
                    expectedOwnerType: dependencies.ownerType,
                    expectedOwnerId: normalizedOwnerId
                });
            }
            return { cleanupPending: false };
        } catch (cleanupError) {
            return { cleanupPending: true, cleanupError };
        }
    };
    if (shouldDeletePrevious && previousImageId) {
        const verifyPreviousAsset = dependencies.verifyPreviousAsset
            ?? (dependencies.deleteAsset
                ? async () => true
                : async (imageId: string, expectedOwnerId: string) => {
                    const asset = await ImageAsset.findById(imageId);
                    if (!asset) return false;
                    validatedCoverArtObjectKey(
                        asset,
                        imageId,
                        dependencies.ownerType,
                        expectedOwnerId
                    );
                    return true;
                });
        try {
            if (!await verifyPreviousAsset(previousImageId, normalizedOwnerId)) {
                const replacementCleanup = await deleteReplacement();
                return {
                    cleanupPending: true,
                    updateApplied: false,
                    cleanupError: new Error('Cover-art lifecycle evidence is missing.'),
                    replacementCleanupPending: replacementCleanup.cleanupPending,
                    replacementCleanupError: replacementCleanup.cleanupError
                };
            }
        } catch (cleanupError) {
            const replacementCleanup = await deleteReplacement();
            return {
                cleanupPending: true,
                updateApplied: false,
                cleanupError,
                replacementCleanupPending: replacementCleanup.cleanupPending,
                replacementCleanupError: replacementCleanup.cleanupError
            };
        }
    }

    let ownerUpdate: unknown;
    let ownerUpdateError: unknown;
    try {
        ownerUpdate = shouldDeletePrevious && dependencies.updateOwnerIfCoverArtMatches
            ? await dependencies.updateOwnerIfCoverArtMatches(
                normalizedOwnerId,
                previousImageId,
                update
            )
            : await dependencies.updateOwner(normalizedOwnerId, update);
    } catch (error) {
        ownerUpdateError = error;
    }
    if ((ownerUpdateError as any)?.outcomeUnknown) {
        // A relationship transaction may have committed even when its result was
        // lost. Preserve both old and replacement assets until exact cross-record
        // reconciliation can establish which reference is authoritative.
        return {
            cleanupPending: true,
            updateApplied: false,
            cleanupError: ownerUpdateError,
            replacementCleanupPending: Boolean(replacementImageId),
            reconciliationRequired: true,
            outcomeUnknown: true
        };
    }
    if (ownerUpdateError && !coverArtLifecycleWriteMayHaveCommitted(ownerUpdateError)) {
        const replacementCleanup = await deleteReplacement();
        return {
            cleanupPending: replacementCleanup.cleanupPending,
            updateApplied: false,
            cleanupError: ownerUpdateError,
            replacementCleanupPending: replacementCleanup.cleanupPending,
            replacementCleanupError: replacementCleanup.cleanupError
        };
    }
    let updateApplied = !ownerUpdateError;
    let ownerReportedMatch = false;
    if (ownerUpdate && typeof ownerUpdate === 'object'
        && 'matchedCount' in ownerUpdate) {
        ownerReportedMatch = true;
        updateApplied = Number((ownerUpdate as { matchedCount: unknown }).matchedCount) === 1;
    }
    if (!ownerUpdateError && ownerReportedMatch && !updateApplied) {
        const replacementCleanup = await deleteReplacement();
        return {
            cleanupPending: replacementCleanup.cleanupPending,
            updateApplied: false,
            cleanupError: new Error(
                `${dependencies.ownerType} ${normalizedOwnerId} changed before the update committed.`
            ),
            replacementCleanupPending: replacementCleanup.cleanupPending,
            replacementCleanupError: replacementCleanup.cleanupError
        };
    }
    if (!updateApplied && shouldDeletePrevious) {
        const findOwner = dependencies.findOwner ?? (async (id: string) => {
            const projection = Object.fromEntries([
                ...new Set(['coverArtId', ...Object.keys(update)])
            ].map((field) => [field, 1]));
            return getDb()!.collection(publicOwnerCollections[dependencies.ownerType]).findOne(
                { _id: ObjectId.createFromHexString(id) },
                { projection }
            );
        });
        let owner: any | null;
        try {
            owner = await findOwner(normalizedOwnerId);
        } catch (confirmationError) {
            return {
                cleanupPending: true,
                updateApplied: false,
                cleanupError: ownerUpdateError ?? confirmationError,
                replacementCleanupPending: Boolean(replacementImageId),
                replacementCleanupError: confirmationError,
                reconciliationRequired: Boolean(ownerUpdateError),
                outcomeUnknown: Boolean(ownerUpdateError)
            };
        }
        const currentImageId = String(owner?.coverArtId ?? '');
        const expectedAttachedId = replacementImageId ?? '';
        const attachmentMatches = Boolean(owner) && currentImageId === expectedAttachedId;
        updateApplied = attachmentMatches && ownerFieldsMatchUpdate(owner, update);
        if (!updateApplied) {
            if (ownerUpdateError || attachmentMatches) {
                // A possibly committed write cannot authorize either side's
                // deletion unless the complete owner mutation reads back exactly.
                return {
                    cleanupPending: true,
                    updateApplied: false,
                    cleanupError: ownerUpdateError
                        ?? new Error('Owner update readback was not exact.'),
                    replacementCleanupPending: Boolean(replacementImageId),
                    reconciliationRequired: true,
                    outcomeUnknown: true
                };
            }
            const replacementCleanup = await deleteReplacement();
            return {
                cleanupPending: replacementCleanup.cleanupPending,
                updateApplied: false,
                cleanupError: ownerUpdateError,
                replacementCleanupPending: replacementCleanup.cleanupPending,
                replacementCleanupError: replacementCleanup.cleanupError
            };
        }
    } else if (!updateApplied) {
        throw ownerUpdateError
            ?? new Error(`${dependencies.ownerType} ${normalizedOwnerId} could not be updated.`);
    }
    if (!shouldDeletePrevious || !previousImageId) {
        return { cleanupPending: false, updateApplied: true };
    }

    try {
        if (dependencies.deleteAsset) await dependencies.deleteAsset(previousImageId);
        else {
            await deleteCoverArt(previousImageId, {
                expectedOwnerType: dependencies.ownerType,
                expectedOwnerId: normalizedOwnerId
            });
        }
        return { cleanupPending: false, updateApplied: true };
    } catch (cleanupError) {
        return { cleanupPending: true, updateApplied: true, cleanupError };
    }
};

/** Attaches a newly uploaded image with the same CAS and uncertainty handling as replacement. */
export const attachCoverArtToNewOwner = async (
    ownerId: string,
    coverArt: { imageId: string; coverArtUrl: string },
    dependencies: CoverArtOwnerUpdateDependencies
) => {
    const attachment = await updateCoverArtOwnerAndCleanup(
        ownerId,
        { coverArtId: coverArt.imageId, coverArtUrl: coverArt.coverArtUrl },
        null,
        true,
        dependencies
    );
    if (!attachment.updateApplied) {
        throw Object.assign(
            new Error(`${dependencies.ownerType} cover-art attachment could not be confirmed.`),
            {
                statusCode: attachment.cleanupPending ? 503 : 409,
                code: attachment.cleanupPending
                    ? 'cover_art_attachment_outcome_unknown'
                    : 'cover_art_attachment_conflict',
                cleanupPending: attachment.cleanupPending,
                attachment
            }
        );
    }
    return attachment;
};

/** Deletes an entity only after its object is gone, then finalizes lifecycle evidence. */
export const deleteCoverArtOwner = async (
    ownerType: Exclude<ImageOwnerType, 'user'>,
    ownerId: string,
    imageId: string | undefined | null,
    deleteOwner: () => Promise<unknown>,
    dependencies: CoverArtOwnerDeletionDependencies = {}
) => {
    const normalizedOwnerId = canonicalOwnerId(ownerId);
    const prepare = dependencies.prepareAssetDeletion ?? ((assetId) => prepareCoverArtDeletion(assetId, {
        expectedOwnerType: ownerType,
        expectedOwnerId: normalizedOwnerId
    }));
    const finalize = dependencies.finalizeAssetDeletion ?? finalizeCoverArtDeletion;
    let prepared = false;
    try {
        prepared = await prepare(imageId);
    } catch (cleanupError) {
        return { cleanupPending: true, ownerDeleted: false, cleanupError };
    }
    if (imageId && !prepared) {
        return {
            cleanupPending: true,
            ownerDeleted: false,
            cleanupError: new Error('Cover-art lifecycle evidence is missing.')
        };
    }
    await deleteOwner();

    if (!prepared) return { cleanupPending: false, ownerDeleted: true };
    try {
        await finalize(imageId);
        return { cleanupPending: false, ownerDeleted: true };
    } catch (cleanupError) {
        return { cleanupPending: true, ownerDeleted: true, cleanupError };
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
