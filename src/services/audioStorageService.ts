import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import { AudioTrack } from '../models/audioTrack';
import { cleanupDeletedContentReferences } from './contentReferenceService';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { isAudioObjectKeyForTrack } from '../utils/audioStorageKey';
import {
    finalizeCoverArtDeletion,
    finalizeOwnerCoverArtDeletions,
    prepareCoverArtDeletion,
    prepareOwnerCoverArtDeletions
} from './imageStorageService';

const errorMessage = (error: unknown) => {
    if (error instanceof Error) {
        return error.message.substring(0, 500);
    }
    return String(error).substring(0, 500);
};

export class AudioStorageLifecycleError extends Error {
    readonly cause: unknown;

    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code: string,
        public readonly cleanupPending: boolean,
        public readonly outcomeUnknown = false,
        cause?: unknown
    ) {
        super(message);
        this.cause = cause;
    }
}

const storageMutationConflict = (message: string, cleanupPending = false) =>
    new AudioStorageLifecycleError(
        message,
        409,
        'audio_storage_mutation_conflict',
        cleanupPending
    );

const uploadLifecycleFailure = (
    error: unknown,
    cleanupPending: boolean,
    outcomeUnknown = false
) => new AudioStorageLifecycleError(
    error instanceof Error ? error.message : String(error),
    outcomeUnknown ? 503 : 500,
    outcomeUnknown ? 'audio_upload_outcome_unknown' : 'audio_upload_failed',
    cleanupPending,
    outcomeUnknown,
    error
);

const encodeMetadataValue = (value: string) => {
    return encodeURIComponent(value).substring(0, 1800);
};

export { isAudioObjectKeyForTrack } from '../utils/audioStorageKey';

/** Rejects stored keys that are not cryptographically namespaced to the track identity. */
const validatedAudioObjectKey = (value: unknown, audioTrackId: string) => {
    if (!isAudioObjectKeyForTrack(value, audioTrackId)) {
        throw new Error('Audio track storage key is missing or invalid.');
    }
    return value as string;
};

/** Provides deterministic boundaries for versioned upload and cleanup tests. */
export interface AudioUploadDependencies {
    findTrack: (audioTrackId: string) => Promise<any | null>;
    updateTrackWhere: (
        audioTrackId: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>
    ) => Promise<{ matchedCount: number }>;
    putObject: (
        s3Key: string,
        uploadFile: Express.Multer.File,
        ownerId: string,
        abortSignal?: AbortSignal
    ) => Promise<void>;
    deleteObject: (s3Key: string) => Promise<void>;
    createObjectKey: (audioTrackId: string) => string;
}

const defaultAudioUploadDependencies: AudioUploadDependencies = {
    findTrack: audioTrackId => AudioTrack.findById(audioTrackId),
    updateTrackWhere: async (audioTrackId, expected, update) => {
        return getDb()!.collection('audioTracks').updateOne(
            { _id: ObjectId.createFromHexString(audioTrackId), ...expected },
            { $set: update }
        );
    },
    putObject: async (s3Key, uploadFile, ownerId, abortSignal) => {
        const originalFileName = normalizeUtf8Text(uploadFile.originalname);
        const body = uploadFile.path ? createReadStream(uploadFile.path) : uploadFile.buffer;
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key,
            Body: body,
            ContentLength: uploadFile.size,
            ContentType: uploadFile.mimetype || 'audio/mpeg',
            Metadata: {
                trackid: s3Key.split('/')[1] ?? s3Key,
                ownerid: ownerId,
                originalfilename: encodeMetadataValue(originalFileName)
            }
        }), { abortSignal });
    },
    deleteObject: async s3Key => {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key
        }));
    },
    createObjectKey: audioTrackId => `audio/${audioTrackId.toLowerCase()}/${new ObjectId().toHexString()}`
};

/** Isolates deletion lifecycle boundaries so partial failures and retries are deterministic. */
export interface AudioTrackDeletionDependencies {
    findTrack: (audioTrackId: string) => Promise<any | null>;
    beginDeletion: (
        audioTrackId: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>
    ) => Promise<{ matchedCount: number }>;
    updateTrackWhere: (
        audioTrackId: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>
    ) => Promise<{ matchedCount: number }>;
    deleteAudioObject: (s3Key: string) => Promise<void>;
    prepareTrackCoverArtDeletion: (
        imageId: string | undefined | null,
        audioTrackId: string
    ) => Promise<boolean>;
    prepareTrackCoverArtAssets?: (
        audioTrackId: string,
        currentImageId: string | undefined | null
    ) => Promise<string[]>;
    finalizeTrackCoverArtDeletion: (imageId: string | undefined | null) => Promise<void>;
    finalizeTrackCoverArtAssets?: (imageIds: readonly string[]) => Promise<void>;
    cleanupReferences: typeof cleanupDeletedContentReferences;
    deleteTrack: (
        audioTrackId: string,
        expected: Record<string, unknown>
    ) => Promise<{ deletedCount: number }>;
}

const defaultAudioTrackDeletionDependencies: AudioTrackDeletionDependencies = {
    findTrack: audioTrackId => AudioTrack.findById(audioTrackId),
    beginDeletion: async (audioTrackId, expected, update) => {
        return getDb()!.collection('audioTracks').updateOne(
            { _id: ObjectId.createFromHexString(audioTrackId), ...expected },
            { $set: update }
        );
    },
    updateTrackWhere: async (audioTrackId, expected, update) => {
        return getDb()!.collection('audioTracks').updateOne(
            { _id: ObjectId.createFromHexString(audioTrackId), ...expected },
            { $set: update }
        );
    },
    deleteAudioObject: async s3Key => {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key
        }));
    },
    prepareTrackCoverArtDeletion: (imageId, audioTrackId) => prepareCoverArtDeletion(imageId, {
        expectedOwnerType: 'audioTrack',
        expectedOwnerId: ObjectId.createFromHexString(audioTrackId).toHexString()
    }),
    prepareTrackCoverArtAssets: (audioTrackId, currentImageId) =>
        prepareOwnerCoverArtDeletions('audioTrack', audioTrackId, currentImageId),
    finalizeTrackCoverArtDeletion: imageId => finalizeCoverArtDeletion(imageId),
    finalizeTrackCoverArtAssets: finalizeOwnerCoverArtDeletions,
    cleanupReferences: cleanupDeletedContentReferences,
    deleteTrack: async (audioTrackId, expected) => {
        return getDb()!.collection('audioTracks').deleteOne({
            _id: ObjectId.createFromHexString(audioTrackId),
            ...expected
        });
    }
};

export const uploadAudioObject = async (
    audioTrackId: string,
    uploadFile: Express.Multer.File,
    ownerId: string,
    abortSignal?: AbortSignal,
    dependencies: Partial<AudioUploadDependencies> = {}
) => {
    const upload = { ...defaultAudioUploadDependencies, ...dependencies };
    let track = await upload.findTrack(audioTrackId);
    if (!track) throw new Error(`Audio track ${audioTrackId} no longer exists.`);
    if (track.uploadStatus === 'deleting' || track.uploadStatus === 'deleteFailed') {
        throw storageMutationConflict(
            `Audio track ${audioTrackId} cannot be uploaded while deletion is pending.`
        );
    }
    if (track.pendingS3Key && track.pendingUploadStatus === 'pending') {
        throw storageMutationConflict(
            `Audio track ${audioTrackId} already has an upload in progress.`
        );
    }

    if (track.pendingS3Key) {
        const stalePendingKey = validatedAudioObjectKey(track.pendingS3Key, audioTrackId);
        try {
            await upload.deleteObject(stalePendingKey);
        } catch (cleanupError) {
            await upload.updateTrackWhere(
                audioTrackId,
                {
                    s3Key: track.s3Key,
                    uploadStatus: track.uploadStatus,
                    pendingS3Key: stalePendingKey,
                    pendingUploadStatus: track.pendingUploadStatus ?? null,
                    storageCleanupS3Key: track.storageCleanupS3Key ?? null
                },
                {
                    pendingUploadStatus: 'failed',
                    pendingUploadUpdatedAt: new Date(),
                    pendingUploadError: errorMessage(cleanupError)
                }
            ).catch(() => undefined);
            throw storageMutationConflict(
                `Audio track ${audioTrackId} has a failed pending object that must be cleaned up first.`,
                true
            );
        }
        const clearedPending = await upload.updateTrackWhere(
            audioTrackId,
            {
                s3Key: track.s3Key,
                uploadStatus: track.uploadStatus,
                pendingS3Key: stalePendingKey,
                pendingUploadStatus: track.pendingUploadStatus ?? null,
                storageCleanupS3Key: track.storageCleanupS3Key ?? null
            },
            {
                pendingS3Key: null,
                pendingUploadStatus: null,
                pendingUploadUpdatedAt: new Date(),
                pendingUploadError: null
            }
        );
        if (clearedPending.matchedCount !== 1) {
            throw storageMutationConflict(
                `Audio track ${audioTrackId} changed while pending-object cleanup was finalizing.`,
                true
            );
        }
        track = {
            ...track,
            pendingS3Key: null,
            pendingUploadStatus: null,
            pendingUploadError: null
        };
    }

    if (track.storageCleanupS3Key) {
        const staleCleanupKey = validatedAudioObjectKey(
            track.storageCleanupS3Key,
            audioTrackId
        );
        try {
            await upload.deleteObject(staleCleanupKey);
        } catch (cleanupError) {
            await upload.updateTrackWhere(
                audioTrackId,
                {
                    s3Key: track.s3Key,
                    uploadStatus: track.uploadStatus,
                    pendingS3Key: null,
                    storageCleanupS3Key: staleCleanupKey,
                    storageCleanupStatus: track.storageCleanupStatus ?? null
                },
                {
                    storageCleanupStatus: 'deleteFailed',
                    storageCleanupUpdatedAt: new Date(),
                    storageCleanupError: errorMessage(cleanupError)
                }
            ).catch(() => undefined);
            throw storageMutationConflict(
                `Audio track ${audioTrackId} has a previous object that must be cleaned up first.`,
                true
            );
        }
        const clearedCleanup = await upload.updateTrackWhere(
            audioTrackId,
            {
                s3Key: track.s3Key,
                uploadStatus: track.uploadStatus,
                pendingS3Key: null,
                storageCleanupS3Key: staleCleanupKey,
                storageCleanupStatus: track.storageCleanupStatus ?? null
            },
            {
                storageCleanupS3Key: null,
                storageCleanupStatus: null,
                storageCleanupUpdatedAt: new Date(),
                storageCleanupError: null
            }
        );
        if (clearedCleanup.matchedCount !== 1) {
            throw storageMutationConflict(
                `Audio track ${audioTrackId} changed while previous-object cleanup was finalizing.`,
                true
            );
        }
        track = {
            ...track,
            storageCleanupS3Key: null,
            storageCleanupStatus: null,
            storageCleanupError: null
        };
    }

    const originalFileName = normalizeUtf8Text(uploadFile.originalname);
    const contentType = uploadFile.mimetype || 'audio/mpeg';
    const replacementS3Key = upload.createObjectKey(audioTrackId);
    validatedAudioObjectKey(replacementS3Key, audioTrackId);
    const previousS3Key = track.s3Key
        ? validatedAudioObjectKey(track.s3Key, audioTrackId)
        : undefined;
    const reservation = await upload.updateTrackWhere(
        audioTrackId,
        {
            s3Key: track.s3Key,
            uploadStatus: track.uploadStatus,
            pendingS3Key: null,
            storageCleanupS3Key: null
        },
        {
            pendingS3Key: replacementS3Key,
            pendingUploadStatus: 'pending',
            pendingUploadUpdatedAt: new Date(),
            pendingUploadError: null
        }
    );
    if (reservation.matchedCount !== 1) {
        throw storageMutationConflict(
            `Audio track ${audioTrackId} already has a storage mutation in progress.`
        );
    }

    try {
        await upload.putObject(replacementS3Key, uploadFile, ownerId, abortSignal);
    } catch (error) {
        let cleanupFailed = false;
        try {
            await upload.deleteObject(replacementS3Key);
        } catch {
            cleanupFailed = true;
        }
        let statusUpdateFailed = false;
        try {
            await upload.updateTrackWhere(
                audioTrackId,
                { pendingS3Key: replacementS3Key },
                {
                    pendingS3Key: cleanupFailed ? replacementS3Key : null,
                    pendingUploadStatus: 'failed',
                    pendingUploadUpdatedAt: new Date(),
                    pendingUploadError: errorMessage(error),
                    ...(track.uploadStatus === 'ready' ? {} : {
                        uploadStatus: 'failed',
                        uploadUpdatedAt: new Date(),
                        uploadError: errorMessage(error)
                    })
                }
            );
        } catch (statusError) {
            statusUpdateFailed = true;
            console.log(`Unable to mark audio track ${audioTrackId} replacement as failed:`, statusError);
        }
        throw uploadLifecycleFailure(error, cleanupFailed || statusUpdateFailed);
    }

    let attached = false;
    try {
        const readyUpdate = await upload.updateTrackWhere(
            audioTrackId,
            { pendingS3Key: replacementS3Key },
            {
                originalFileName,
                contentType,
                s3Key: replacementS3Key,
                uploadStatus: 'ready',
                uploadUpdatedAt: new Date(),
                uploadError: null,
                pendingS3Key: null,
                pendingUploadStatus: null,
                pendingUploadUpdatedAt: new Date(),
                pendingUploadError: null,
                storageCleanupS3Key: previousS3Key && previousS3Key !== replacementS3Key
                    ? previousS3Key
                    : null,
                storageCleanupStatus: previousS3Key && previousS3Key !== replacementS3Key
                    ? 'pending'
                    : null,
                storageCleanupUpdatedAt: new Date(),
                storageCleanupError: null
            }
        );
        attached = readyUpdate.matchedCount === 1;
        if (!attached) {
            const current = await upload.findTrack(audioTrackId);
            attached = current?.uploadStatus === 'ready'
                && current?.s3Key === replacementS3Key;
        }
        if (!attached) {
            throw new Error(`Audio track ${audioTrackId} replacement could not be finalized.`);
        }
    } catch (error) {
        if (!attached) {
            try {
                const current = await upload.findTrack(audioTrackId);
                attached = current?.uploadStatus === 'ready'
                    && current?.s3Key === replacementS3Key;
            } catch (confirmationError) {
                // An indeterminate database result must retain the pending key for reconciliation.
                throw uploadLifecycleFailure(
                    { attachmentError: error, confirmationError },
                    true,
                    true
                );
            }
        }
        if (!attached) {
            let cleanupFailed = false;
            try {
                await upload.deleteObject(replacementS3Key);
            } catch {
                cleanupFailed = true;
            }
            let statusUpdateFailed = false;
            try {
                await upload.updateTrackWhere(
                    audioTrackId,
                    { pendingS3Key: replacementS3Key },
                    {
                        pendingS3Key: cleanupFailed ? replacementS3Key : null,
                        pendingUploadStatus: 'failed',
                        pendingUploadUpdatedAt: new Date(),
                        pendingUploadError: errorMessage(error),
                        ...(track.uploadStatus === 'ready' ? {} : {
                            uploadStatus: 'failed',
                            uploadUpdatedAt: new Date(),
                            uploadError: errorMessage(error)
                        })
                    }
                );
            } catch {
                statusUpdateFailed = true;
            }
            throw uploadLifecycleFailure(error, cleanupFailed || statusUpdateFailed);
        }
    }

    if (!previousS3Key || previousS3Key === replacementS3Key) {
        return { cleanupPending: false, s3Key: replacementS3Key };
    }

    try {
        await upload.deleteObject(previousS3Key);
        const cleanupUpdate = await upload.updateTrackWhere(
            audioTrackId,
            {
                s3Key: replacementS3Key,
                uploadStatus: 'ready',
                pendingS3Key: null,
                storageCleanupS3Key: previousS3Key
            },
            {
                storageCleanupS3Key: null,
                storageCleanupStatus: null,
                storageCleanupUpdatedAt: new Date(),
                storageCleanupError: null
            }
        );
        return {
            cleanupPending: cleanupUpdate.matchedCount !== 1,
            s3Key: replacementS3Key
        };
    } catch (cleanupError) {
        await upload.updateTrackWhere(
            audioTrackId,
            {
                s3Key: replacementS3Key,
                uploadStatus: 'ready',
                pendingS3Key: null,
                storageCleanupS3Key: previousS3Key
            },
            {
                storageCleanupStatus: 'deleteFailed',
                storageCleanupUpdatedAt: new Date(),
                storageCleanupError: errorMessage(cleanupError)
            }
        ).catch(() => undefined);
        return {
            cleanupPending: true,
            cleanupError,
            s3Key: replacementS3Key
        };
    }
};

export const deleteAudioObjectAndTrack = async (
    audioTrackId: string,
    dependencies: Partial<AudioTrackDeletionDependencies> = {}
) => {
    const deletion = { ...defaultAudioTrackDeletionDependencies, ...dependencies };
    const usesLegacyCoverHooks = dependencies.prepareTrackCoverArtDeletion !== undefined
        || dependencies.finalizeTrackCoverArtDeletion !== undefined;
    const track = await deletion.findTrack(audioTrackId);
    if (!track) {
        throw new Error(`Audio track ${audioTrackId} no longer exists.`);
    }
    if (track.pendingUploadStatus === 'pending' && track.pendingS3Key) {
        throw storageMutationConflict(`Audio track ${audioTrackId} has an upload in progress.`);
    }
    const storageIdentity = {
        s3Key: track.s3Key,
        pendingS3Key: track.pendingS3Key ?? null,
        pendingUploadStatus: track.pendingUploadStatus ?? null,
        storageCleanupS3Key: track.storageCleanupS3Key ?? null
    };
    let audioObjectKeys: string[];
    try {
        audioObjectKeys = [...new Set([
            track.s3Key,
            track.pendingS3Key,
            track.storageCleanupS3Key
        ].filter((value): value is string => Boolean(value)).map((value) => {
            return validatedAudioObjectKey(value, audioTrackId);
        }))];
        if (audioObjectKeys.length === 0) {
            throw new Error('Audio track storage key is missing or invalid.');
        }
    } catch (error) {
        await deletion.updateTrackWhere(audioTrackId, {
            ...storageIdentity,
            uploadStatus: track.uploadStatus
        }, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error),
            referenceCleanupStatus: 'failed',
            referenceCleanupUpdatedAt: new Date(),
            referenceCleanupError: errorMessage(error)
        }).catch(() => undefined);
        throw error;
    }

    const deletingUpdate = await deletion.beginDeletion(
        audioTrackId,
        {
            ...storageIdentity,
            uploadStatus: track.uploadStatus,
        },
        {
            uploadStatus: 'deleting',
            uploadUpdatedAt: new Date(),
            uploadError: null,
            referenceCleanupStatus: 'pending',
            referenceCleanupUpdatedAt: new Date(),
            referenceCleanupError: null
        }
    );
    if (deletingUpdate.matchedCount !== 1) {
        throw storageMutationConflict(
            `Audio track ${audioTrackId} changed before deletion could be fenced.`
        );
    }

    let coverArtPrepared = false;
    let preparedCoverArtIds: string[] = [];
    try {
        if (usesLegacyCoverHooks) {
            coverArtPrepared = await deletion.prepareTrackCoverArtDeletion(
                track.coverArtId,
                audioTrackId
            );
            if (track.coverArtId && !coverArtPrepared) {
                throw new Error('Cover-art lifecycle evidence is missing.');
            }
            if (coverArtPrepared && track.coverArtId) {
                preparedCoverArtIds = [String(track.coverArtId)];
            }
        } else {
            preparedCoverArtIds = await deletion.prepareTrackCoverArtAssets!(
                audioTrackId,
                track.coverArtId
            );
            coverArtPrepared = preparedCoverArtIds.length > 0;
        }
        for (const s3Key of audioObjectKeys) {
            await deletion.deleteAudioObject(s3Key);
        }
    } catch (error) {
        await deletion.updateTrackWhere(audioTrackId, {
            ...storageIdentity,
            uploadStatus: 'deleting'
        }, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch((statusError) => {
            console.log(`Unable to mark audio track ${audioTrackId} deletion as failed:`, statusError);
        });
        throw error;
    }

    let referenceCleanupCompleted = false;
    try {
        await deletion.cleanupReferences('audioTrack', audioTrackId);
        const cleanupUpdate = await deletion.updateTrackWhere(audioTrackId, {
            ...storageIdentity,
            uploadStatus: 'deleting',
            referenceCleanupStatus: 'pending'
        }, {
            referenceCleanupStatus: 'complete',
            referenceCleanupUpdatedAt: new Date(),
            referenceCleanupError: null
        });
        if (cleanupUpdate.matchedCount !== 1) {
            throw new Error(`Audio track ${audioTrackId} no longer exists.`);
        }
        referenceCleanupCompleted = true;

        let deleteError: unknown;
        try {
            const deletedTrack = await deletion.deleteTrack(audioTrackId, {
                ...storageIdentity,
                uploadStatus: 'deleting',
                referenceCleanupStatus: 'complete'
            });
            if (deletedTrack.deletedCount === 1) deleteError = undefined;
            else deleteError = new Error(`Audio track ${audioTrackId} could not be finalized.`);
        } catch (error) {
            deleteError = error;
        }
        if (deleteError) {
            let currentTrack: any | null;
            try {
                currentTrack = await deletion.findTrack(audioTrackId);
            } catch (confirmationError) {
                throw Object.assign(
                    new Error(`Audio track ${audioTrackId} deletion outcome could not be confirmed.`),
                    {
                        code: 'audio_deletion_outcome_unknown',
                        cause: { deleteError, confirmationError }
                    }
                );
            }
            if (currentTrack != null) throw deleteError;
        }
    } catch (error) {
        await deletion.updateTrackWhere(audioTrackId, {
            ...storageIdentity,
            uploadStatus: 'deleting'
        }, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error),
            referenceCleanupStatus: referenceCleanupCompleted ? 'complete' : 'failed',
            referenceCleanupUpdatedAt: new Date(),
            referenceCleanupError: referenceCleanupCompleted ? null : errorMessage(error)
        }).catch((statusError) => {
            console.log(`Unable to mark audio track ${audioTrackId} reference cleanup as failed:`, statusError);
        });
        throw error;
    }

    if (!coverArtPrepared) return { cleanupPending: false };
    try {
        if (usesLegacyCoverHooks) {
            await deletion.finalizeTrackCoverArtDeletion(track.coverArtId);
        } else {
            await deletion.finalizeTrackCoverArtAssets!(preparedCoverArtIds);
        }
        return { cleanupPending: false };
    } catch (cleanupError) {
        // The Soundtrack is gone, but its exact lifecycle record remains auditable.
        return { cleanupPending: true, cleanupError };
    }
};
