import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import {
    isAudioStorageCandidateKey,
    reconcileAudioStorage
} from './audioReconciliationService';
import {
    AudioStorageLifecycleError,
    deleteAudioObjectAndTrack,
    isAudioObjectKeyForTrack
} from './audioStorageService';

export type OrphanAudioDeletionResult = {
    s3Key: string;
    status: 'deleted' | 'alreadyAbsent';
};

export type MissingAudioTrackDeletionResult = {
    audioTrackId: string;
    status: 'deleted' | 'alreadyAbsent';
    cleanupPending: boolean;
};

export class AudioStorageRemediationError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code: string,
        public readonly outcomeUnknown = false
    ) {
        super(message);
    }
}

export interface OrphanAudioDeletionDependencies {
    reconcile: typeof reconcileAudioStorage;
    isReferenced: (s3Key: string) => Promise<boolean>;
    objectExists: (s3Key: string) => Promise<boolean>;
    deleteObject: (s3Key: string) => Promise<void>;
}

export interface MissingAudioTrackDeletionDependencies {
    reconcile: typeof reconcileAudioStorage;
    trackExists: (audioTrackId: string) => Promise<boolean>;
    deleteTrack: (
        audioTrackId: string,
        expectedS3Key: string
    ) => Promise<{ cleanupPending: boolean }>;
}

const isMissingObjectError = (error: any) => {
    const statusCode = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode);
    return statusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey';
};

const defaultDependencies: OrphanAudioDeletionDependencies = {
    reconcile: reconcileAudioStorage,
    isReferenced: async s3Key => Boolean(await getDb()!.collection('audioTracks').findOne({
        $or: [
            { s3Key },
            { pendingS3Key: s3Key },
            { storageCleanupS3Key: s3Key }
        ]
    }, { projection: { _id: 1 } })),
    objectExists: async s3Key => {
        try {
            await getS3().send(new HeadObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: s3Key
            }));
            return true;
        } catch (error) {
            if (isMissingObjectError(error)) return false;
            throw error;
        }
    },
    deleteObject: async s3Key => {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key
        }));
    }
};

const defaultMissingTrackDependencies: MissingAudioTrackDeletionDependencies = {
    reconcile: reconcileAudioStorage,
    trackExists: async audioTrackId => Boolean(await getDb()!.collection('audioTracks').findOne({
        _id: ObjectId.createFromHexString(audioTrackId)
    }, { projection: { _id: 1 } })),
    deleteTrack: (audioTrackId, expectedS3Key) => deleteAudioObjectAndTrack(
        audioTrackId,
        {},
        expectedS3Key
    )
};

/** Deletes one exact, currently orphaned audio object without discarding database evidence. */
export const deleteOrphanedAudioStorageObject = async (
    rawS3Key: unknown,
    dependencies: Partial<OrphanAudioDeletionDependencies> = {}
): Promise<OrphanAudioDeletionResult> => {
    const s3Key = typeof rawS3Key === 'string' ? rawS3Key.trim() : '';
    if (!s3Key
        || Buffer.byteLength(s3Key, 'utf8') > 1024
        || s3Key.includes('\0')
        || !isAudioStorageCandidateKey(s3Key)) {
        throw new AudioStorageRemediationError(
            'A valid audio-storage S3 key is required.',
            400,
            'invalid_audio_storage_key'
        );
    }

    const remediation = { ...defaultDependencies, ...dependencies };
    if (await remediation.isReferenced(s3Key)) {
        throw new AudioStorageRemediationError(
            'This S3 object is referenced by Soundtrack lifecycle evidence and cannot be deleted as an orphan.',
            409,
            'audio_storage_object_referenced'
        );
    }

    const report = await remediation.reconcile();
    const isConfirmedOrphan = Array.isArray(report.orphanedObjects)
        && report.orphanedObjects.some((object: any) => String(object.key ?? '') === s3Key);
    if (!isConfirmedOrphan) {
        if (!(await remediation.objectExists(s3Key))) {
            return { s3Key, status: 'alreadyAbsent' };
        }
        throw new AudioStorageRemediationError(
            'This S3 object is no longer confirmed as orphaned. Refresh the audit before taking action.',
            409,
            'audio_storage_object_not_orphaned'
        );
    }

    // Close the report-to-delete window against any raw lifecycle reference that appeared meanwhile.
    if (await remediation.isReferenced(s3Key)) {
        throw new AudioStorageRemediationError(
            'This S3 object became referenced and was not deleted.',
            409,
            'audio_storage_object_referenced'
        );
    }

    try {
        await remediation.deleteObject(s3Key);
    } catch (error) {
        throw new AudioStorageRemediationError(
            'S3 did not confirm deletion. The object remains unresolved and should be reconciled before retrying.',
            503,
            'audio_storage_delete_unconfirmed',
            true
        );
    }

    try {
        if (await remediation.objectExists(s3Key)) {
            throw new AudioStorageRemediationError(
                'S3 still reports the object after deletion. Refresh the audit before retrying.',
                503,
                'audio_storage_delete_unconfirmed',
                true
            );
        }
    } catch (error) {
        if (error instanceof AudioStorageRemediationError) throw error;
        throw new AudioStorageRemediationError(
            'The deletion outcome could not be verified. Refresh the audit before retrying.',
            503,
            'audio_storage_delete_unconfirmed',
            true
        );
    }

    return { s3Key, status: 'deleted' };
};

/** Removes one report-confirmed MongoDB-only Soundtrack through its normal lifecycle. */
export const deleteMissingAudioTrackRecord = async (
    rawAudioTrackId: unknown,
    rawExpectedS3Key: unknown,
    dependencies: Partial<MissingAudioTrackDeletionDependencies> = {}
): Promise<MissingAudioTrackDeletionResult> => {
    const audioTrackId = typeof rawAudioTrackId === 'string'
        ? rawAudioTrackId.trim().toLowerCase()
        : '';
    const expectedS3Key = typeof rawExpectedS3Key === 'string'
        ? rawExpectedS3Key.trim()
        : '';
    if (!ObjectId.isValid(audioTrackId)
        || ObjectId.createFromHexString(audioTrackId).toHexString() !== audioTrackId
        || !isAudioObjectKeyForTrack(expectedS3Key, audioTrackId)) {
        throw new AudioStorageRemediationError(
            'A valid Soundtrack ID and matching audio-storage key are required.',
            400,
            'invalid_missing_audio_track'
        );
    }

    const remediation = { ...defaultMissingTrackDependencies, ...dependencies };
    const report = await remediation.reconcile();
    const isConfirmedMissing = Array.isArray(report.missingObjects)
        && report.missingObjects.some((track: any) => (
            String(track.audioTrackId ?? '').toLowerCase() === audioTrackId
            && String(track.s3Key ?? '') === expectedS3Key
        ));
    if (!isConfirmedMissing) {
        if (!(await remediation.trackExists(audioTrackId))) {
            return { audioTrackId, status: 'alreadyAbsent', cleanupPending: false };
        }
        throw new AudioStorageRemediationError(
            'This Soundtrack is no longer confirmed as MongoDB-only. Refresh the audit before taking action.',
            409,
            'audio_track_not_confirmed_missing'
        );
    }

    try {
        const deletion = await remediation.deleteTrack(audioTrackId, expectedS3Key);
        return {
            audioTrackId,
            status: 'deleted',
            cleanupPending: deletion.cleanupPending
        };
    } catch (error) {
        if (error instanceof AudioStorageLifecycleError) {
            throw new AudioStorageRemediationError(
                error.outcomeUnknown
                    ? 'The Soundtrack deletion outcome could not be confirmed. Reconciliation is required.'
                    : 'The Soundtrack changed or could not be deleted safely. Its database record was retained for retry.',
                error.statusCode,
                error.code,
                error.outcomeUnknown
            );
        }
        throw new AudioStorageRemediationError(
            'The Soundtrack could not be deleted safely. Its database record was retained for retry and reconciliation.',
            503,
            'missing_audio_track_delete_failed'
        );
    }
};
