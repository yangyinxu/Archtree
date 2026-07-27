import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';

type ListedImageObject = {
    key: string;
    size: number;
    lastModified?: Date;
};

const listImageObjects = async (bucket: string) => {
    const objects: ListedImageObject[] = [];
    let continuationToken: string | undefined;

    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'images/',
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

export const reconcileImageStorage = async () => {
    const db = getDb();
    if (!db) {
        throw new Error('Database is unavailable.');
    }

    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    const [assets, s3Objects] = await Promise.all([
        db.collection('imageAssets').find().toArray(),
        listImageObjects(bucket)
    ]);
    const assetsByKey = new Map(assets.map((asset) => [String(asset.s3Key), asset]));
    const s3Keys = new Set(s3Objects.map((object) => object.key));

    const orphanedObjects = await Promise.all(
        s3Objects
            .filter((object) => !assetsByKey.has(object.key))
            .map(async (object) => {
                try {
                    const head = await getS3().send(new HeadObjectCommand({
                        Bucket: bucket,
                        Key: object.key
                    }));
                    return {
                        ...object,
                        imageId: String(head.Metadata?.imageid ?? ''),
                        ownerType: String(head.Metadata?.ownertype ?? ''),
                        ownerId: String(head.Metadata?.ownerid ?? ''),
                        createdBy: String(head.Metadata?.createdby ?? '')
                    };
                } catch (error) {
                    return {
                        ...object,
                        metadataError: error instanceof Error ? error.message : String(error)
                    };
                }
            })
    );

    const missingObjects = assets
        .filter((asset) => !s3Keys.has(String(asset.s3Key)))
        .map((asset) => ({
            imageId: String(asset._id),
            s3Key: String(asset.s3Key),
            ownerType: String(asset.ownerType),
            ownerId: String(asset.ownerId),
            uploadStatus: String(asset.uploadStatus),
            uploadUpdatedAt: asset.uploadUpdatedAt ?? null,
            uploadError: String(asset.uploadError ?? '')
        }));
    const incompleteAssets = assets
        .filter((asset) => asset.uploadStatus !== 'ready')
        .map((asset) => ({
            imageId: String(asset._id),
            s3Key: String(asset.s3Key),
            ownerType: String(asset.ownerType),
            ownerId: String(asset.ownerId),
            uploadStatus: String(asset.uploadStatus),
            uploadUpdatedAt: asset.uploadUpdatedAt ?? null,
            uploadError: String(asset.uploadError ?? ''),
            objectExists: s3Keys.has(String(asset.s3Key))
        }));
    const ownerCollections = {
        artist: 'artists',
        album: 'albums',
        audioTrack: 'audioTracks'
    } as const;
    const ownersByTypeAndId = new Map<string, any>();
    await Promise.all(Object.entries(ownerCollections).map(async ([ownerType, collectionName]) => {
        const ownerIds = assets
            .filter((asset) => asset.ownerType === ownerType && ObjectId.isValid(String(asset.ownerId)))
            .map((asset) => new ObjectId(String(asset.ownerId)));
        if (ownerIds.length === 0) return;
        const owners = await db.collection(collectionName).find(
            { _id: { $in: ownerIds } },
            { projection: { coverArtId: 1 } }
        ).toArray();
        owners.forEach((owner) => ownersByTypeAndId.set(`${ownerType}:${String(owner._id)}`, owner));
    }));
    const detachedAssets = assets
        .filter((asset) => {
            const owner = ownersByTypeAndId.get(`${String(asset.ownerType)}:${String(asset.ownerId)}`);
            return !owner || String(owner.coverArtId ?? '') !== String(asset._id);
        })
        .map((asset) => ({
            imageId: String(asset._id),
            s3Key: String(asset.s3Key),
            ownerType: String(asset.ownerType),
            ownerId: String(asset.ownerId),
            uploadStatus: String(asset.uploadStatus),
            objectExists: s3Keys.has(String(asset.s3Key))
        }));

    return {
        generatedAt: new Date(),
        bucket,
        summary: {
            databaseImageCount: assets.length,
            s3ImageCount: s3Objects.length,
            orphanedObjectCount: orphanedObjects.length,
            missingObjectCount: missingObjects.length,
            incompleteImageCount: incompleteAssets.length,
            detachedImageCount: detachedAssets.length
        },
        orphanedObjects,
        missingObjects,
        incompleteAssets,
        detachedAssets
    };
};
