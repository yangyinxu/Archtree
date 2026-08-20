import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import { isAudioObjectKeyForTrack } from '../utils/audioStorageKey';
import { isVideoObjectKeyForTrack } from '../utils/videoStorageKey';
import {
    activeMediaTypeForTrack,
    isMediaObjectKeyForTrack,
    persistedMediaType,
    type MediaType
} from '../utils/mediaStorageKey';

type ListedS3Object = {
    key: string;
    size: number;
    lastModified?: Date;
};

/** Keeps image and private-avatar namespaces out of audio orphan classification. */
export const isAudioStorageObjectKey = (key: string) => {
    return /^[0-9a-f]{24}$/i.test(key)
        || /^audio\/[0-9a-f]{24}\/[0-9a-f]{24}$/i.test(key);
};

/** Audits malformed objects inside the owned audio namespace instead of silently skipping them. */
export const isAudioStorageCandidateKey = (key: string) => {
    return /^[0-9a-f]{24}$/i.test(key) || key.startsWith('audio/');
};

/** Recognizes only the owned versioned video namespace. */
export const isVideoStorageObjectKey = (key: string) =>
    /^video\/[0-9a-f]{24}\/[0-9a-f]{24}$/i.test(key);

/** Audits malformed keys inside video/ instead of treating them as unrelated data. */
export const isVideoStorageCandidateKey = (key: string) => key.startsWith('video/');
const configuredReconciliationLimit = Number(process.env.MAX_RECONCILIATION_OBJECTS ?? 50_000);
const reconciliationLimit = Number.isFinite(configuredReconciliationLimit) && configuredReconciliationLimit > 0
    ? Math.floor(configuredReconciliationLimit)
    : 50_000;

const decodeMetadataValue = (value?: string) => {
    if (!value) return '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const listS3Objects = async (
    bucket: string,
    isCandidate: (key: string) => boolean,
    prefix?: string
): Promise<ListedS3Object[]> => {
    const objects: ListedS3Object[] = [];
    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();

    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            Prefix: prefix
        }));
        for (const object of page.Contents ?? []) {
            if (!object.Key || !isCandidate(object.Key)) continue;
            objects.push({
                key: object.Key,
                size: Number(object.Size ?? 0),
                lastModified: object.LastModified
            });
            if (objects.length > reconciliationLimit) {
                throw new Error(`Audio reconciliation exceeds the ${reconciliationLimit} object safety limit.`);
            }
        }
        const nextToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (nextToken && seenContinuationTokens.has(nextToken)) {
            throw new Error('S3 returned a repeated continuation token while auditing audio storage.');
        }
        if (nextToken) seenContinuationTokens.add(nextToken);
        continuationToken = nextToken;
    } while (continuationToken);

    return objects;
};

const videoReferenceFields = [
    ['active', 'videoAsset.active.s3Key'],
    ['pending', 'videoAsset.pending.s3Key'],
    ['cleanup', 'videoAsset.cleanup.s3Key']
] as const;

const legacyVideoReferences = (track: any) => videoReferenceFields.flatMap(([phase, field]) => {
    const lifecycle = track?.videoAsset?.[phase];
    return lifecycle?.s3Key ? [{
        audioTrackId: String(track._id),
        phase,
        field,
        s3Key: String(lifecycle.s3Key),
        status: String(lifecycle.status ?? ''),
        updatedAt: lifecycle.updatedAt ?? null,
        error: String(lifecycle.error ?? '').slice(0, 500)
    }] : [];
});

const topLevelReferenceFields = [
    ['active', 's3Key', 'mediaType'],
    ['pending', 'pendingS3Key', 'pendingMediaType'],
    ['cleanup', 'storageCleanupS3Key', 'storageCleanupMediaType']
] as const;

const rawTopLevelReferences = (track: any) => topLevelReferenceFields.flatMap(([
    phase,
    keyField,
    typeField
]) => {
    const s3Key = track?.[keyField];
    if (!s3Key) return [];
    const fallbackType: MediaType = phase === 'cleanup'
        ? 'audio'
        : persistedMediaType(track?.mediaType);
    return [{
        audioTrackId: String(track._id),
        phase,
        field: keyField,
        s3Key: String(s3Key),
        mediaType: persistedMediaType(track?.[typeField] ?? fallbackType),
        status: phase === 'active'
            ? String(track.uploadStatus ?? '')
            : phase === 'pending'
                ? String(track.pendingUploadStatus ?? '')
                : String(track.storageCleanupStatus ?? ''),
        updatedAt: phase === 'active'
            ? track.uploadUpdatedAt ?? null
            : phase === 'pending'
                ? track.pendingUploadUpdatedAt ?? null
                : track.storageCleanupUpdatedAt ?? null,
        error: String(phase === 'active'
            ? track.uploadError ?? ''
            : phase === 'pending'
                ? track.pendingUploadError ?? ''
                : track.storageCleanupError ?? '').slice(0, 500)
    }];
});

const rawVideoReferences = (track: any) => [
    ...rawTopLevelReferences(track).filter((reference) => reference.mediaType === 'video'),
    ...legacyVideoReferences(track)
];

/** Reports raw video-key reuse even when one owner binding is malformed. */
export const findDuplicateVideoStorageKeys = (tracks: any[]) => {
    const ownersByKey = new Map<string, string[]>();
    tracks.flatMap(rawVideoReferences).forEach((reference) => {
        const owners = ownersByKey.get(reference.s3Key) ?? [];
        owners.push(reference.audioTrackId);
        ownersByKey.set(reference.s3Key, owners);
    });
    return [...ownersByKey.entries()]
        .filter(([, owners]) => new Set(owners).size > 1)
        .map(([s3Key, audioTrackIds]) => ({
            s3Key,
            audioTrackIds: [...new Set(audioTrackIds)]
        }));
};

/** Projects retryable legacy-video lifecycle phases without exposing the whole MediaTrack. */
export const findIncompleteVideoTracks = (
    tracks: any[],
    s3Keys: ReadonlySet<string>
) => tracks.flatMap((track) => {
    const asset = track?.videoAsset;
    const hasLegacyEvidence = Boolean(asset);
    const hasTopLevelVideoIssue = rawTopLevelReferences(track).some((reference) => (
        reference.mediaType === 'video' && reference.phase !== 'active'
    ));
    if (!hasLegacyEvidence && !hasTopLevelVideoIssue) {
        return [];
    }
    return [{
        audioTrackId: String(track._id),
        title: String(track.title ?? ''),
        revision: Number.isSafeInteger(asset?.revision) ? asset.revision : null,
        references: rawVideoReferences(track).map((reference) => ({
            ...reference,
            objectExists: s3Keys.has(reference.s3Key)
        }))
    }];
});

const loadOrphanMetadata = async (bucket: string, objects: ListedS3Object[]) => {
    const results: Array<ListedS3Object & {
        trackId: string;
        ownerId: string;
        originalFileName: string;
        metadataError?: string;
    }> = [];

    for (let index = 0; index < objects.length; index += 10) {
        const batch = objects.slice(index, index + 10);
        const batchResults = await Promise.all(batch.map(async (object) => {
            try {
                const head = await getS3().send(new HeadObjectCommand({
                    Bucket: bucket,
                    Key: object.key
                }));
                return {
                    ...object,
                    trackId: String(head.Metadata?.trackid ?? ''),
                    ownerId: String(head.Metadata?.ownerid ?? ''),
                    originalFileName: decodeMetadataValue(head.Metadata?.originalfilename)
                };
            } catch (error: any) {
                return {
                    ...object,
                    trackId: '',
                    ownerId: '',
                    originalFileName: '',
                    metadataError: String(error?.message ?? error)
                };
            }
        }));
        results.push(...batchResults);
    }

    return results;
};

/** Reports a raw lifecycle key shared across tracks even when one reference is identity-invalid. */
export const findDuplicateAudioStorageKeys = (tracks: any[]) => {
    const trackIdsByKey = new Map<string, string[]>();
    tracks.flatMap((track) => {
        return [track.s3Key, track.pendingS3Key, track.storageCleanupS3Key]
            .filter((key): key is string => Boolean(key))
            .map((key) => [key, track] as const);
    }).forEach(([s3Key, track]) => {
        const trackIds = trackIdsByKey.get(s3Key) ?? [];
        trackIds.push(String(track._id));
        trackIdsByKey.set(s3Key, trackIds);
    });
    return [...trackIdsByKey.entries()]
        .filter(([, audioTrackIds]) => new Set(audioTrackIds).size > 1)
        .map(([s3Key, audioTrackIds]) => ({
            s3Key,
            audioTrackIds: [...new Set(audioTrackIds)]
        }));
};

/** Projects every recoverable storage or publication lifecycle into the audit DTO. */
export const findIncompleteAudioTracks = (
    tracks: any[],
    s3Keys: ReadonlySet<string>
) => tracks
    .filter((track) => (track.uploadStatus && track.uploadStatus !== 'ready')
        || (Object.prototype.hasOwnProperty.call(track, 'publicationStatus')
            && track.publicationStatus !== 'ready')
        || track.pendingUploadStatus
        || track.storageCleanupStatus)
    .map((track) => ({
        audioTrackId: String(track._id),
        s3Key: String(track.s3Key ?? ''),
        title: String(track.title ?? ''),
        originalFileName: String(track.originalFileName ?? ''),
        ownerId: String(track.createdBy ?? ''),
        uploadStatus: String(track.uploadStatus),
        uploadUpdatedAt: track.uploadUpdatedAt ?? null,
        uploadError: String(track.uploadError ?? '').slice(0, 500),
        objectExists: s3Keys.has(String(track.s3Key ?? '')),
        publicationStatus: Object.prototype.hasOwnProperty.call(track, 'publicationStatus')
            ? String(track.publicationStatus)
            : 'legacy',
        publicationUpdatedAt: track.publicationUpdatedAt ?? null,
        publicationError: String(track.publicationError ?? '').slice(0, 500),
        pendingS3Key: String(track.pendingS3Key ?? ''),
        pendingUploadStatus: String(track.pendingUploadStatus ?? ''),
        pendingUploadUpdatedAt: track.pendingUploadUpdatedAt ?? null,
        pendingUploadError: String(track.pendingUploadError ?? '').slice(0, 500),
        pendingObjectExists: track.pendingS3Key
            ? s3Keys.has(String(track.pendingS3Key))
            : false,
        storageCleanupS3Key: String(track.storageCleanupS3Key ?? ''),
        storageCleanupStatus: String(track.storageCleanupStatus ?? ''),
        storageCleanupUpdatedAt: track.storageCleanupUpdatedAt ?? null,
        storageCleanupError: String(track.storageCleanupError ?? '').slice(0, 500),
        cleanupObjectExists: track.storageCleanupS3Key
            ? s3Keys.has(String(track.storageCleanupS3Key))
            : false
    }));

export const reconcileAudioStorage = async () => {
    const db = getDb();
    if (!db) {
        throw new Error('Database is unavailable.');
    }

    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    const [tracks, allS3Objects, videoS3Objects] = await Promise.all([
        db.collection('audioTracks').find({}, {
            projection: {
                title: 1,
                originalFileName: 1,
                createdBy: 1,
                s3Key: 1,
                mediaType: 1,
                uploadStatus: 1,
                uploadUpdatedAt: 1,
                uploadError: 1,
                publicationStatus: 1,
                publicationUpdatedAt: 1,
                publicationError: 1,
                pendingS3Key: 1,
                pendingMediaType: 1,
                pendingUploadStatus: 1,
                pendingUploadUpdatedAt: 1,
                pendingUploadError: 1,
                storageCleanupS3Key: 1,
                storageCleanupMediaType: 1,
                storageCleanupStatus: 1,
                storageCleanupUpdatedAt: 1,
                storageCleanupError: 1,
                videoAsset: 1
            }
        }).limit(reconciliationLimit + 1).toArray(),
        listS3Objects(bucket, isAudioStorageCandidateKey),
        listS3Objects(bucket, isVideoStorageCandidateKey, 'video/')
    ]);
    if (tracks.length > reconciliationLimit) {
        throw new Error(`Audio reconciliation exceeds the ${reconciliationLimit} database-record safety limit.`);
    }
    const s3Objects = allS3Objects;

    const trackKeyEntries = tracks.flatMap((track) => {
        const audioTrackId = String(track._id);
        return rawTopLevelReferences(track)
            .filter((reference) => reference.mediaType === 'audio')
            .filter((reference) => isAudioObjectKeyForTrack(reference.s3Key, audioTrackId))
            .map((reference) => [reference.s3Key, track] as const);
    });
    const tracksByKey = new Map(trackKeyEntries);
    const s3Keys = new Set(s3Objects.map((object) => object.key));
    const orphanCandidates = s3Objects.filter((object) => !tracksByKey.has(object.key));
    const orphanedObjects = await loadOrphanMetadata(bucket, orphanCandidates);
    const missingObjects = tracks
        .filter((track) => activeMediaTypeForTrack(track) === 'audio')
        .filter((track) => {
            const s3Key = String(track.s3Key ?? '');
            return !isAudioObjectKeyForTrack(s3Key, String(track._id)) || !s3Keys.has(s3Key);
        })
        .map((track) => ({
            audioTrackId: String(track._id),
            s3Key: String(track.s3Key ?? ''),
            title: String(track.title ?? ''),
            originalFileName: String(track.originalFileName ?? ''),
            ownerId: String(track.createdBy ?? ''),
            uploadStatus: String(track.uploadStatus ?? 'legacy'),
            uploadUpdatedAt: track.uploadUpdatedAt ?? null,
            uploadError: String(track.uploadError ?? '').slice(0, 500),
            publicationStatus: Object.prototype.hasOwnProperty.call(track, 'publicationStatus')
                ? String(track.publicationStatus)
                : 'legacy',
            publicationUpdatedAt: track.publicationUpdatedAt ?? null,
            publicationError: String(track.publicationError ?? '').slice(0, 500)
        }));
    const incompleteTracks = findIncompleteAudioTracks(tracks, s3Keys);
    const invalidStorageKeys = tracks.flatMap((track) => {
        const audioTrackId = String(track._id);
        return rawTopLevelReferences(track).flatMap((reference) => {
            if (isMediaObjectKeyForTrack(
                reference.s3Key,
                audioTrackId,
                reference.mediaType
            )) return [];
            return [{
                audioTrackId,
                field: reference.field,
                mediaType: reference.mediaType,
                s3Key: reference.s3Key
            }];
        });
    });
    const duplicateStorageKeys = findDuplicateAudioStorageKeys(tracks);
    const invalidStorageObjects = s3Objects.filter((object) => {
        return !isAudioStorageObjectKey(object.key);
    });

    const videoS3Keys = new Set(videoS3Objects.map((object) => object.key));
    const validVideoReferences = tracks.flatMap(rawVideoReferences).filter((reference) => (
        isVideoObjectKeyForTrack(reference.s3Key, reference.audioTrackId)
    ));
    const videoReferencesByKey = new Map(
        validVideoReferences.map((reference) => [reference.s3Key, reference] as const)
    );
    const videoOrphanedObjects = await loadOrphanMetadata(
        bucket,
        videoS3Objects.filter((object) => !videoReferencesByKey.has(object.key))
    );
    const missingVideoObjects = validVideoReferences
        .filter((reference) => !videoS3Keys.has(reference.s3Key));
    const invalidVideoStorageKeys = tracks.flatMap(rawVideoReferences)
        .filter((reference) => !isVideoObjectKeyForTrack(
            reference.s3Key,
            reference.audioTrackId
        ));
    const incompleteVideoTracks = findIncompleteVideoTracks(tracks, videoS3Keys);
    const duplicateVideoStorageKeys = findDuplicateVideoStorageKeys(tracks);
    const invalidVideoStorageObjects = videoS3Objects.filter((object) => (
        !isVideoStorageObjectKey(object.key)
    ));

    return {
        generatedAt: new Date(),
        bucket,
        summary: {
            databaseTrackCount: tracks.length,
            s3ObjectCount: s3Objects.length,
            orphanedObjectCount: orphanedObjects.length,
            missingObjectCount: missingObjects.length,
            incompleteTrackCount: incompleteTracks.length,
            invalidStorageKeyCount: invalidStorageKeys.length,
            duplicateStorageKeyCount: duplicateStorageKeys.length,
            invalidStorageObjectCount: invalidStorageObjects.length
        },
        orphanedObjects,
        missingObjects,
        incompleteTracks,
        invalidStorageKeys,
        duplicateStorageKeys,
        invalidStorageObjects,
        videoStorage: {
            summary: {
                databaseVideoTrackCount: tracks.filter((track) => (
                    activeMediaTypeForTrack(track) === 'video'
                    || track.videoAsset != null
                )).length,
                s3ObjectCount: videoS3Objects.length,
                orphanedObjectCount: videoOrphanedObjects.length,
                missingObjectCount: missingVideoObjects.length,
                incompleteTrackCount: incompleteVideoTracks.length,
                invalidStorageKeyCount: invalidVideoStorageKeys.length,
                duplicateStorageKeyCount: duplicateVideoStorageKeys.length,
                invalidStorageObjectCount: invalidVideoStorageObjects.length
            },
            orphanedObjects: videoOrphanedObjects,
            missingObjects: missingVideoObjects,
            incompleteTracks: incompleteVideoTracks,
            invalidStorageKeys: invalidVideoStorageKeys,
            duplicateStorageKeys: duplicateVideoStorageKeys,
            invalidStorageObjects: invalidVideoStorageObjects
        }
    };
};
