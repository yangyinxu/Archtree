import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { isAudioObjectKeyForTrack } from '../utils/audioStorageKey';
import {
    confirmReadyAudioTrackAlbumUpdate,
    publishUploadedAudioTracks,
    relinkReadyAudioTracksToAlbum
} from './albumTrackLinkService';

export const maximumAudioPublicationRetries = 100;

export interface AudioPublicationRetryResult {
    audioTrackId: string;
    albumId: string;
    uploadStatus: string;
    uploadReady: boolean;
    publicationStatusBefore: string;
    publicationStatus: string;
    outcome: 'ready' | 'failed' | 'unknown' | 'notFound' | 'invalid' | 'duplicate';
    error: string | null;
}

export interface AudioPublicationRecoveryDependencies {
    findRecords?: (audioTrackIds: readonly string[]) => Promise<any[]>;
    findRecord?: (audioTrackId: string) => Promise<any | null>;
    confirmPublication?: (audioTrackId: string, albumId: string) => Promise<boolean>;
}

const boundedError = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Bounds a retry request while retaining invalid or duplicate IDs for per-item outcomes. */
export const normalizeAudioPublicationRetryIds = (values: readonly unknown[]) => {
    if (values.length === 0 || values.length > maximumAudioPublicationRetries) {
        throw new Error(
            `audioTrackIds must contain between 1 and ${maximumAudioPublicationRetries} IDs.`
        );
    }
    return values.map((value) => String(value ?? '').trim().toLowerCase());
};

const publicationStatusLabel = (record: any) =>
    Object.prototype.hasOwnProperty.call(record ?? {}, 'publicationStatus')
        ? String(record.publicationStatus)
        : 'legacy';

const defaultFindRecords = (audioTrackIds: readonly string[]) => getDb()!
    .collection('audioTracks').find({
        _id: { $in: audioTrackIds.map((id) => ObjectId.createFromHexString(id)) }
    }).project({
        _id: 1,
        albumId: 1,
        s3Key: 1,
        uploadStatus: 1,
        publicationStatus: 1,
        publicationError: 1
    }).limit(audioTrackIds.length).toArray();

const defaultFindRecord = (audioTrackId: string) => getDb()!.collection('audioTracks').findOne(
    { _id: ObjectId.createFromHexString(audioTrackId) },
    { projection: { publicationStatus: 1, publicationError: 1 } }
);

/**
 * Replays only the database publication transaction for already-uploaded
 * Soundtracks. Each item is isolated so one failed Album relationship cannot
 * hide the successful outcome of another item in the same request.
 */
export const retryAudioTrackPublications = async (
    audioTrackIds: readonly string[],
    dependencies: AudioPublicationRecoveryDependencies = {}
) => {
    const normalizedIds = normalizeAudioPublicationRetryIds(audioTrackIds);
    const validIds = [...new Set(normalizedIds.filter((id) => /^[0-9a-f]{24}$/.test(id)))];
    const findRecords = dependencies.findRecords ?? defaultFindRecords;
    const findRecord = dependencies.findRecord ?? defaultFindRecord;
    const confirmPublication = dependencies.confirmPublication
        ?? ((audioTrackId: string, albumId: string) =>
            confirmReadyAudioTrackAlbumUpdate(audioTrackId, albumId, {}, 'published'));
    let records: any[] = [];
    let recordsLoadError: unknown;
    if (validIds.length > 0) {
        try {
            records = await findRecords(validIds);
        } catch (error) {
            recordsLoadError = error;
        }
    }
    const recordsById = new Map(records.map((record) => [
        String(record._id).toLowerCase(),
        record
    ]));
    const results: AudioPublicationRetryResult[] = [];
    const seenIds = new Set<string>();

    for (const audioTrackId of normalizedIds) {
        if (!/^[0-9a-f]{24}$/.test(audioTrackId)) {
            results.push({
                audioTrackId,
                albumId: '',
                uploadStatus: 'invalid',
                uploadReady: false,
                publicationStatusBefore: 'invalid',
                publicationStatus: 'invalid',
                outcome: 'invalid',
                error: 'Soundtrack ID is invalid.'
            });
            continue;
        }
        if (seenIds.has(audioTrackId)) {
            results.push({
                audioTrackId,
                albumId: '',
                uploadStatus: 'duplicate',
                uploadReady: false,
                publicationStatusBefore: 'duplicate',
                publicationStatus: 'duplicate',
                outcome: 'duplicate',
                error: 'Soundtrack ID is duplicated in this retry request.'
            });
            continue;
        }
        seenIds.add(audioTrackId);
        if (recordsLoadError) {
            results.push({
                audioTrackId,
                albumId: '',
                uploadStatus: 'unknown',
                uploadReady: false,
                publicationStatusBefore: 'unknown',
                publicationStatus: 'unknown',
                outcome: 'unknown',
                error: `Publication source read failed: ${boundedError(recordsLoadError)}`
            });
            continue;
        }
        const record = recordsById.get(audioTrackId);
        if (!record) {
            results.push({
                audioTrackId,
                albumId: '',
                uploadStatus: 'missing',
                uploadReady: false,
                publicationStatusBefore: 'missing',
                publicationStatus: 'missing',
                outcome: 'notFound',
                error: 'Soundtrack not found.'
            });
            continue;
        }

        const albumId = String(record.albumId ?? '').trim().toLowerCase();
        const uploadStatus = String(record.uploadStatus ?? 'legacy');
        const uploadReady = uploadStatus === 'ready'
            && isAudioObjectKeyForTrack(record.s3Key, audioTrackId);
        const publicationStatusBefore = publicationStatusLabel(record);
        if (!uploadReady) {
            results.push({
                audioTrackId,
                albumId,
                uploadStatus,
                uploadReady,
                publicationStatusBefore,
                publicationStatus: publicationStatusBefore,
                outcome: 'failed',
                error: 'The existing uploaded object is not database-confirmed ready.'
            });
            continue;
        }

        try {
            if (publicationStatusBefore === 'legacy' || publicationStatusBefore === 'ready') {
                await relinkReadyAudioTracksToAlbum(albumId, [audioTrackId]);
            } else {
                await publishUploadedAudioTracks(albumId, [audioTrackId]);
            }
            if (!await confirmPublication(audioTrackId, albumId)) {
                throw new Error('Publication transaction did not establish the exact Album relationship.');
            }
            results.push({
                audioTrackId,
                albumId,
                uploadStatus,
                uploadReady,
                publicationStatusBefore,
                publicationStatus: publicationStatusBefore === 'legacy' ? 'legacy' : 'ready',
                outcome: 'ready',
                error: null
            });
        } catch (error) {
            let confirmed = false;
            let confirmationError: unknown;
            try {
                confirmed = await confirmPublication(audioTrackId, albumId);
            } catch (readbackError) {
                confirmationError = readbackError;
            }
            if (confirmed) {
                results.push({
                    audioTrackId,
                    albumId,
                    uploadStatus,
                    uploadReady,
                    publicationStatusBefore,
                    publicationStatus: publicationStatusBefore === 'legacy' ? 'legacy' : 'ready',
                    outcome: 'ready',
                    error: null
                });
                continue;
            }
            let current: any | null = null;
            try {
                current = await findRecord(audioTrackId);
            } catch (readbackError) {
                confirmationError ??= readbackError;
            }
            const outcome = confirmationError ? 'unknown' : 'failed';
            results.push({
                audioTrackId,
                albumId,
                uploadStatus,
                uploadReady,
                publicationStatusBefore,
                publicationStatus: current
                    ? publicationStatusLabel(current)
                    : confirmationError ? 'unknown' : publicationStatusBefore,
                outcome,
                error: boundedError(current?.publicationError || confirmationError || error)
            });
        }
    }

    const readyCount = results.filter((result) => result.outcome === 'ready').length;
    return {
        requestedCount: results.length,
        readyCount,
        failedCount: results.length - readyCount,
        results
    };
};
