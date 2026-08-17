import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { UserLibrary } from '../models/userLibrary';
import { cleanupAudioTrackPlaylistReferences } from './playlistLifecycleService';
import { readyArtistLifecycleFilter } from './artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from './albumReferenceFenceService';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { readyOrganizationLifecycleFilter } from './organizationReferenceFenceService';

export type ContentReferenceType = 'artist' | 'album' | 'audioTrack';
type ValidatedContentReferenceType = ContentReferenceType | 'organization';

const referenceConfig: Record<ValidatedContentReferenceType, { collection: string; label: string }> = {
    artist: { collection: 'artists', label: 'Artist' },
    organization: { collection: 'organizations', label: 'Organization' },
    album: { collection: 'albums', label: 'Album' },
    audioTrack: { collection: 'audioTracks', label: 'Audio track' }
};

export type ContentReferenceValidation = {
    valid: boolean;
    ids: string[];
    message?: string;
};

const orderedManualItemCleanup = (
    contentType: 'album' | 'audioTrack',
    referenceIds: Array<string | ObjectId>
) => ([
    {
        $set: {
            items: {
                $let: {
                    vars: {
                        retainedItems: {
                            $filter: {
                                input: { $cond: [{ $isArray: '$items' }, '$items', []] },
                                as: 'item',
                                cond: {
                                    $not: [{
                                        $and: [
                                            { $eq: ['$$item.contentType', contentType] },
                                            { $in: ['$$item.contentId', referenceIds] }
                                        ]
                                    }]
                                }
                            }
                        }
                    },
                    in: {
                        $map: {
                            input: { $range: [0, { $size: '$$retainedItems' }] },
                            as: 'index',
                            in: {
                                $mergeObjects: [
                                    { $arrayElemAt: ['$$retainedItems', '$$index'] },
                                    { order: '$$index' }
                                ]
                            }
                        }
                    }
                }
            },
            updatedAt: '$$NOW'
        }
    }
]);

/** Validates administrator-selected shared references without treating provenance as permission. */
export const validateContentReferences = async (
    type: ValidatedContentReferenceType,
    values: string[]
): Promise<ContentReferenceValidation> => {
    const config = referenceConfig[type];
    const ids = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    if (ids.length > 100) {
        return {
            valid: false,
            ids: [],
            message: `No more than 100 ${config.label.toLowerCase()} references may be processed at once.`
        };
    }
    if (ids.length === 0) {
        if (values.length > 0) {
            return {
                valid: false,
                ids,
                message: `${config.label} ID is required.`
            };
        }
        return { valid: true, ids };
    }

    const invalidId = ids.find((id) => !ObjectId.isValid(id) || String(new ObjectId(id)) !== id.toLowerCase());
    if (invalidId) {
        return {
            valid: false,
            ids,
            message: `${config.label} ID "${invalidId}" is not a valid ID.`
        };
    }

    const db = getDb();
    if (!db) {
        throw new Error('Database is unavailable.');
    }

    const documents = await db.collection(config.collection).find({
        _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
        ...(type === 'artist'
            ? readyArtistLifecycleFilter
            : type === 'organization'
                ? readyOrganizationLifecycleFilter
                : type === 'album'
                    ? readyAlbumLifecycleFilter
                    : readyAudioStorageFilter)
    }, {
        projection: { _id: 1 }
    }).toArray();
    const documentsById = new Map(documents.map((document) => [String(document._id), document]));

    const missingId = ids.find((id) => !documentsById.has(id));
    if (missingId) {
        return {
            valid: false,
            ids,
            message: `${config.label} ID "${missingId}" does not refer to an existing ${config.label.toLowerCase()}.`
        };
    }

    return { valid: true, ids };
};

/** Idempotently detaches shared references before the final content record is deleted. */
export const cleanupDeletedContentReferences = async (
    type: ContentReferenceType,
    contentId: string
) => {
    const db = getDb()!;
    const operations: Promise<unknown>[] = [];
    let canonicalContentId = contentId;
    const referenceIds: Array<string | ObjectId> = [];
    try {
        const objectId = ObjectId.createFromHexString(contentId);
        canonicalContentId = objectId.toHexString();
        referenceIds.push(canonicalContentId, canonicalContentId.toUpperCase(), objectId);
        if (contentId !== canonicalContentId) referenceIds.push(contentId);
    } catch {
        // Legacy string references can still be removed when the ID is not canonical.
        referenceIds.push(contentId);
    }

    if (type === 'artist') {
        const removeArtistCreditPipeline = [
            {
                $set: {
                    credits: {
                        $filter: {
                            input: '$credits',
                            as: 'credit',
                            cond: { $not: [{ $and: [
                                { $eq: ['$$credit.subjectType', 'artist'] },
                                { $in: ['$$credit.subjectId', referenceIds] }
                            ] }] }
                        }
                    }
                }
            },
            {
                $set: {
                    credits: {
                        $map: {
                            input: { $range: [0, { $size: '$credits' }] },
                            as: 'index',
                            in: {
                                $mergeObjects: [
                                    { $arrayElemAt: ['$credits', '$$index'] },
                                    { order: '$$index' }
                                ]
                            }
                        }
                    },
                    attributionStatus: {
                        $cond: [{ $eq: [{ $size: '$credits' }, 0] }, 'unknown', 'documented']
                    },
                    creditRevision: { $add: [{ $ifNull: ['$creditRevision', 0] }, 1] }
                }
            }
        ];
        operations.push(
            db.collection('audioTracks').updateMany(
                { artistIds: { $in: referenceIds } },
                { $pull: { artistIds: { $in: referenceIds } } } as any
            ),
            db.collection('albums').updateMany(
                { credits: { $elemMatch: { subjectType: 'artist', subjectId: { $in: referenceIds } } } },
                removeArtistCreditPipeline as any
            ),
            db.collection('audioTracks').updateMany(
                { credits: { $elemMatch: { subjectType: 'artist', subjectId: { $in: referenceIds } } } },
                removeArtistCreditPipeline as any
            ),
            db.collection('carousels').updateMany(
                {
                    mode: 'artist',
                    'artistConfig.artistId': { $in: referenceIds }
                },
                {
                    $set: {
                        mode: 'manual',
                        items: [],
                        updatedAt: new Date()
                    },
                    $unset: { artistConfig: '' }
                } as any
            )
        );
    } else {
        const contentType = type;
        const matchingItem = {
            contentType,
            contentId: { $in: referenceIds }
        };
        operations.push(
            UserLibrary.cleanupContent(contentType, canonicalContentId),
            db.collection('carousels').updateMany(
                { mode: 'manual', items: { $elemMatch: matchingItem } },
                orderedManualItemCleanup(contentType, referenceIds) as any
            ),
            db.collection('contentCollections').updateMany(
                { mode: 'manual', items: { $elemMatch: matchingItem } },
                orderedManualItemCleanup(contentType, referenceIds) as any
            )
        );
    }
    if (type === 'album') {
        operations.push(
            db.collection('artists').updateMany(
                { albumIds: { $in: referenceIds } },
                { $pull: { albumIds: { $in: referenceIds } } } as any
            ),
            db.collection('audioTracks').updateMany(
                { albumId: { $in: referenceIds } },
                { $unset: { albumId: '' } }
            )
        );
    } else if (type === 'audioTrack') {
        operations.push(
            db.collection('albums').updateMany(
                { audioTrackIds: { $in: referenceIds } },
                { $pull: { audioTrackIds: { $in: referenceIds } } } as any
            ),
            cleanupAudioTrackPlaylistReferences(canonicalContentId)
        );
    }
    await Promise.all(operations);
};
