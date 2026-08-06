import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';
import { isAudioObjectKeyForTrack } from '../utils/audioStorageKey';

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

const listS3Objects = async (bucket: string): Promise<ListedS3Object[]> => {
    const objects: ListedS3Object[] = [];
    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();

    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));
        for (const object of page.Contents ?? []) {
            if (!object.Key || !isAudioStorageCandidateKey(object.Key)) continue;
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

    const [tracks, allS3Objects] = await Promise.all([
        db.collection('audioTracks').find({}, {
            projection: {
                title: 1,
                originalFileName: 1,
                createdBy: 1,
                s3Key: 1,
                uploadStatus: 1,
                uploadUpdatedAt: 1,
                uploadError: 1,
                publicationStatus: 1,
                publicationUpdatedAt: 1,
                publicationError: 1,
                pendingS3Key: 1,
                pendingUploadStatus: 1,
                pendingUploadUpdatedAt: 1,
                pendingUploadError: 1,
                storageCleanupS3Key: 1,
                storageCleanupStatus: 1,
                storageCleanupUpdatedAt: 1,
                storageCleanupError: 1
            }
        }).limit(reconciliationLimit + 1).toArray(),
        listS3Objects(bucket)
    ]);
    if (tracks.length > reconciliationLimit) {
        throw new Error(`Audio reconciliation exceeds the ${reconciliationLimit} database-record safety limit.`);
    }
    const s3Objects = allS3Objects;

    const trackKeyEntries = tracks.flatMap((track) => {
        const audioTrackId = String(track._id);
        return [track.s3Key, track.pendingS3Key, track.storageCleanupS3Key]
            .filter((key): key is string => Boolean(key))
            .filter((key) => isAudioObjectKeyForTrack(key, audioTrackId))
            .map((key) => [key, track] as const);
    });
    const tracksByKey = new Map(trackKeyEntries);
    const s3Keys = new Set(s3Objects.map((object) => object.key));
    const orphanCandidates = s3Objects.filter((object) => !tracksByKey.has(object.key));
    const orphanedObjects = await loadOrphanMetadata(bucket, orphanCandidates);
    const missingObjects = tracks
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
        return [
            ['s3Key', track.s3Key],
            ['pendingS3Key', track.pendingS3Key],
            ['storageCleanupS3Key', track.storageCleanupS3Key]
        ].flatMap(([field, value]) => {
            if (!value || isAudioObjectKeyForTrack(value, audioTrackId)) return [];
            return [{ audioTrackId, field: String(field), s3Key: String(value) }];
        });
    });
    const duplicateStorageKeys = findDuplicateAudioStorageKeys(tracks);
    const invalidStorageObjects = s3Objects.filter((object) => {
        return !isAudioStorageObjectKey(object.key);
    });

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
        invalidStorageObjects
    };
};
