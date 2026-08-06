import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDb } from '../infrastructure/database';
import { getS3 } from '../infrastructure/s3';

type ListedImageObject = {
    key: string;
    size: number;
    lastModified?: Date;
};

const ownerDefinitions = {
    artist: { collectionName: 'artists', referenceField: 'coverArtId' },
    album: { collectionName: 'albums', referenceField: 'coverArtId' },
    audioTrack: { collectionName: 'audioTracks', referenceField: 'coverArtId' },
    user: { collectionName: 'users', referenceField: 'avatarAssetId' }
} as const;

type ImageOwnerType = keyof typeof ownerDefinitions;
type OwnerDefinition = typeof ownerDefinitions[ImageOwnerType];

export interface ImageReconciliationDependencies {
    bucket?: string;
    loadAssets?: () => Promise<any[]>;
    loadOwners?: (
        ownerType: ImageOwnerType,
        definition: OwnerDefinition
    ) => Promise<any[]>;
    listObjects?: (bucket: string, prefix: 'images/' | 'avatars/') => Promise<ListedImageObject[]>;
    headObject?: (bucket: string, key: string) => Promise<any>;
}

const configuredReconciliationLimit = Number(process.env.MAX_RECONCILIATION_OBJECTS ?? 50_000);
const reconciliationLimit = Number.isFinite(configuredReconciliationLimit) && configuredReconciliationLimit > 0
    ? Math.floor(configuredReconciliationLimit)
    : 50_000;

const listImageObjects = async (
    bucket: string,
    prefix: 'images/' | 'avatars/'
): Promise<ListedImageObject[]> => {
    const objects: ListedImageObject[] = [];
    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();

    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken
        }));
        for (const object of page.Contents ?? []) {
            if (!object.Key) continue;
            objects.push({
                key: object.Key,
                size: Number(object.Size ?? 0),
                lastModified: object.LastModified
            });
            if (objects.length > reconciliationLimit) {
                throw new Error(`Image reconciliation exceeds the ${reconciliationLimit} object safety limit.`);
            }
        }
        const nextToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (nextToken && seenContinuationTokens.has(nextToken)) {
            throw new Error(`S3 returned a repeated continuation token while auditing ${prefix} storage.`);
        }
        if (nextToken) seenContinuationTokens.add(nextToken);
        continuationToken = nextToken;
    } while (continuationToken);

    return objects;
};

const expectedPrefix = (ownerType: unknown) => ownerType === 'user' ? 'avatars/' : 'images/';

const hasValidStorageKey = (asset: any) => {
    const s3Key = String(asset?.s3Key ?? '');
    const prefix = expectedPrefix(asset?.ownerType);
    const imageId = String(asset?._id ?? '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(ownerDefinitions, String(asset?.ownerType))
        && /^[0-9a-f]{24}$/.test(imageId)
        && s3Key === `${prefix}${imageId}`;
};

const assetReportItem = (asset: any, s3Keys: Set<string>) => ({
    imageId: String(asset._id),
    s3Key: String(asset.s3Key ?? ''),
    ownerType: String(asset.ownerType ?? ''),
    ownerId: String(asset.ownerId ?? ''),
    uploadStatus: String(asset.uploadStatus ?? ''),
    uploadUpdatedAt: asset.uploadUpdatedAt ?? null,
    uploadError: String(asset.uploadError ?? ''),
    objectExists: s3Keys.has(String(asset.s3Key ?? ''))
});

/** Produces a bounded, report-only audit across public artwork and private avatars. */
export const reconcileImageStorage = async (
    dependencies: ImageReconciliationDependencies = {}
) => {
    const needsDatabase = !dependencies.loadAssets || !dependencies.loadOwners;
    const db = needsDatabase ? getDb() : null;
    if (needsDatabase && !db) {
        throw new Error('Database is unavailable.');
    }

    const bucket = String(dependencies.bucket ?? process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    const loadAssets = dependencies.loadAssets ?? (() => db!.collection('imageAssets')
        .find({})
        .limit(reconciliationLimit + 1)
        .toArray());
    const loadOwners = dependencies.loadOwners ?? ((
        _ownerType: ImageOwnerType,
        definition: OwnerDefinition
    ) => db!.collection(definition.collectionName).find(
        {
            [definition.referenceField]: {
                $exists: true,
                $nin: [null, '']
            }
        },
        { projection: { [definition.referenceField]: 1 } }
    ).limit(reconciliationLimit + 1).toArray());
    const listObjects = dependencies.listObjects ?? listImageObjects;
    const headObject = dependencies.headObject ?? (async (storageBucket: string, key: string) => {
        return getS3().send(new HeadObjectCommand({ Bucket: storageBucket, Key: key }));
    });

    const [assets, coverArtObjects, avatarObjects, ...ownerLists] = await Promise.all([
        loadAssets(),
        listObjects(bucket, 'images/'),
        listObjects(bucket, 'avatars/'),
        ...Object.entries(ownerDefinitions).map(([ownerType, definition]) => {
            return loadOwners(ownerType as ImageOwnerType, definition);
        })
    ]);
    const s3Objects = [...coverArtObjects, ...avatarObjects];
    const referencingOwnerCount = ownerLists.reduce((total, owners) => total + owners.length, 0);
    if (assets.length > reconciliationLimit) {
        throw new Error(`Image reconciliation exceeds the ${reconciliationLimit} database-record safety limit.`);
    }
    if (s3Objects.length > reconciliationLimit) {
        throw new Error(`Image reconciliation exceeds the ${reconciliationLimit} object safety limit.`);
    }
    if (referencingOwnerCount > reconciliationLimit) {
        throw new Error(`Image reconciliation exceeds the ${reconciliationLimit} owner-reference safety limit.`);
    }

    const assetsByKey = new Map(assets.map((asset) => [String(asset.s3Key ?? ''), asset]));
    const assetsById = new Map(assets.map((asset) => [String(asset._id), asset]));
    const s3Keys = new Set(s3Objects.map((object) => object.key));

    const orphanCandidates = s3Objects.filter((object) => !assetsByKey.has(object.key));
    const orphanedObjects: any[] = [];
    for (let index = 0; index < orphanCandidates.length; index += 10) {
        orphanedObjects.push(...await Promise.all(
            orphanCandidates.slice(index, index + 10).map(async (object) => {
                try {
                    const head = await headObject(bucket, object.key);
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
        ));
    }

    const missingObjects = assets
        .filter((asset) => !s3Keys.has(String(asset.s3Key ?? '')))
        .map((asset) => assetReportItem(asset, s3Keys));
    const incompleteAssets = assets
        .filter((asset) => asset.uploadStatus !== 'ready')
        .map((asset) => assetReportItem(asset, s3Keys));
    const invalidStorageKeys = assets
        .filter((asset) => !hasValidStorageKey(asset))
        .map((asset) => assetReportItem(asset, s3Keys));
    const assetIdsByKey = new Map<string, string[]>();
    assets.forEach((asset) => {
        const s3Key = String(asset.s3Key ?? '');
        const ids = assetIdsByKey.get(s3Key) ?? [];
        ids.push(String(asset._id));
        assetIdsByKey.set(s3Key, ids);
    });
    const duplicateStorageKeys = [...assetIdsByKey.entries()]
        .filter(([s3Key, imageIds]) => Boolean(s3Key) && imageIds.length > 1)
        .map(([s3Key, imageIds]) => ({ s3Key, imageIds }));

    const ownersByTypeAndId = new Map<string, any>();
    Object.keys(ownerDefinitions).forEach((ownerType, index) => {
        ownerLists[index].forEach((owner) => {
            ownersByTypeAndId.set(`${ownerType}:${String(owner._id)}`, owner);
        });
    });
    const detachedAssets = assets
        .filter((asset) => {
            const definition = ownerDefinitions[asset.ownerType as ImageOwnerType];
            if (!definition) return true;
            const owner = ownersByTypeAndId.get(`${String(asset.ownerType)}:${String(asset.ownerId)}`);
            return !owner
                || String(owner[definition.referenceField] ?? '') !== String(asset._id);
        })
        .map((asset) => assetReportItem(asset, s3Keys));

    const danglingOwnerReferences = Object.entries(ownerDefinitions).flatMap(
        ([ownerType, definition], index) => ownerLists[index].flatMap((owner) => {
            const imageId = String(owner[definition.referenceField] ?? '');
            const asset = assetsById.get(imageId);
            if (asset
                && String(asset.ownerType) === ownerType
                && String(asset.ownerId) === String(owner._id)) {
                return [];
            }
            return [{
                ownerType,
                ownerId: String(owner._id),
                referenceField: definition.referenceField,
                imageId,
                reason: asset ? 'assetOwnerMismatch' : 'missingAsset'
            }];
        })
    );

    return {
        generatedAt: new Date(),
        bucket,
        summary: {
            databaseImageCount: assets.length,
            databaseCoverArtCount: assets.filter((asset) => asset.ownerType !== 'user').length,
            databaseAvatarCount: assets.filter((asset) => asset.ownerType === 'user').length,
            s3ImageCount: s3Objects.length,
            s3CoverArtCount: coverArtObjects.length,
            s3AvatarCount: avatarObjects.length,
            orphanedObjectCount: orphanedObjects.length,
            missingObjectCount: missingObjects.length,
            incompleteImageCount: incompleteAssets.length,
            detachedImageCount: detachedAssets.length,
            danglingOwnerReferenceCount: danglingOwnerReferences.length,
            invalidStorageKeyCount: invalidStorageKeys.length,
            duplicateStorageKeyCount: duplicateStorageKeys.length
        },
        orphanedObjects,
        missingObjects,
        incompleteAssets,
        detachedAssets,
        danglingOwnerReferences,
        invalidStorageKeys,
        duplicateStorageKeys
    };
};
