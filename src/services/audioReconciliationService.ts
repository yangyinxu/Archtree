import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';

type ListedS3Object = {
    key: string;
    size: number;
    lastModified?: Date;
};

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

    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));
        for (const object of page.Contents ?? []) {
            if (!object.Key) continue;
            objects.push({
                key: object.Key,
                size: Number(object.Size ?? 0),
                lastModified: object.LastModified
            });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
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

export const reconcileAudioStorage = async () => {
    const db = getDb();
    if (!db) {
        throw new Error('Database is unavailable.');
    }

    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    const [tracks, s3Objects] = await Promise.all([
        db.collection('audioTracks').find({}, {
            projection: {
                title: 1,
                originalFileName: 1,
                createdBy: 1,
                s3Key: 1,
                uploadStatus: 1,
                uploadUpdatedAt: 1,
                uploadError: 1
            }
        }).toArray(),
        listS3Objects(bucket)
    ]);

    const tracksByKey = new Map(tracks.map((track) => [
        String(track.s3Key ?? track._id),
        track
    ]));
    const s3Keys = new Set(s3Objects.map((object) => object.key));
    const orphanCandidates = s3Objects.filter((object) => !tracksByKey.has(object.key));
    const orphanedObjects = await loadOrphanMetadata(bucket, orphanCandidates);
    const missingObjects = tracks
        .filter((track) => !s3Keys.has(String(track.s3Key ?? track._id)))
        .map((track) => ({
            audioTrackId: String(track._id),
            s3Key: String(track.s3Key ?? track._id),
            title: String(track.title ?? ''),
            originalFileName: String(track.originalFileName ?? ''),
            ownerId: String(track.createdBy ?? ''),
            uploadStatus: String(track.uploadStatus ?? 'legacy'),
            uploadUpdatedAt: track.uploadUpdatedAt ?? null,
            uploadError: String(track.uploadError ?? '')
        }));
    const incompleteTracks = tracks
        .filter((track) => track.uploadStatus && track.uploadStatus !== 'ready')
        .map((track) => ({
            audioTrackId: String(track._id),
            s3Key: String(track.s3Key ?? track._id),
            title: String(track.title ?? ''),
            originalFileName: String(track.originalFileName ?? ''),
            ownerId: String(track.createdBy ?? ''),
            uploadStatus: String(track.uploadStatus),
            uploadUpdatedAt: track.uploadUpdatedAt ?? null,
            uploadError: String(track.uploadError ?? ''),
            objectExists: s3Keys.has(String(track.s3Key ?? track._id))
        }));

    return {
        generatedAt: new Date(),
        bucket,
        summary: {
            databaseTrackCount: tracks.length,
            s3ObjectCount: s3Objects.length,
            orphanedObjectCount: orphanedObjects.length,
            missingObjectCount: missingObjects.length,
            incompleteTrackCount: incompleteTracks.length
        },
        orphanedObjects,
        missingObjects,
        incompleteTracks
    };
};
