import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import { touchActiveAccount } from './accountReferenceFenceService';

type PageItemReference = {
    itemType?: unknown;
    carouselId?: unknown;
    collectionId?: unknown;
};

export class PageItemReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'page_item_reference_unavailable';

    constructor() {
        super('One or more Page items are unavailable for new references.');
    }
}

const canonicalObjectId = (value: unknown) => {
    const id = String(value ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(id)) throw new PageItemReferenceUnavailableError();
    return id;
};

/**
 * Touches each exact Carousel or Grid/List target in the caller's transaction.
 * The write conflicts with target deletion, so a Page reference cannot commit
 * after the target has been removed.
 */
export const touchAvailablePageItemReferences = async (
    items: readonly PageItemReference[],
    session: ClientSession
) => {
    const normalizedItems = items.map((item) => {
        if (item?.itemType === 'carousel') {
            return { ...item, carouselId: canonicalObjectId(item.carouselId) };
        }
        if (item?.itemType === 'grid' || item?.itemType === 'list') {
            return { ...item, collectionId: canonicalObjectId(item.collectionId) };
        }
        throw new PageItemReferenceUnavailableError();
    });
    const carouselIds = [...new Set(normalizedItems
        .filter((item) => item.itemType === 'carousel')
        .map((item) => String(item.carouselId)))];
    const gridIds = [...new Set(normalizedItems
        .filter((item) => item.itemType === 'grid')
        .map((item) => String(item.collectionId)))];
    const listIds = [...new Set(normalizedItems
        .filter((item) => item.itemType === 'list')
        .map((item) => String(item.collectionId)))];
    const db = getDb()!;
    const touch = async (
        collectionName: 'carousels' | 'contentCollections',
        ids: string[],
        extraFilter: Record<string, unknown> = {}
    ) => {
        if (ids.length === 0) return;
        const result = await db.collection(collectionName).updateMany(
            {
                _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
                ...extraFilter
            },
            { $inc: { referenceRevision: 1 } },
            { session }
        );
        if (result.matchedCount !== ids.length) {
            throw new PageItemReferenceUnavailableError();
        }
    };

    await touch('carousels', carouselIds);
    await touch('contentCollections', gridIds, { presentation: 'grid' });
    await touch('contentCollections', listIds, { presentation: 'list' });
    return normalizedItems;
};

export interface PageTargetDeletionHooks {
    /** Test-only barrier after the target write fence and before Page detachment. */
    afterTargetFence?: () => Promise<void>;
}

const normalizedPageItemsWithout = (field: 'carouselId' | 'collectionId', targetId: string) => ({
    $let: {
        vars: {
            retained: {
                $filter: {
                    input: { $cond: [{ $isArray: '$items' }, '$items', []] },
                    as: 'item',
                    cond: {
                        $ne: [
                            {
                                $toLower: {
                                    $convert: {
                                        input: `$$item.${field}`,
                                        to: 'string',
                                        onError: '',
                                        onNull: ''
                                    }
                                }
                            },
                            targetId
                        ]
                    }
                }
            }
        },
        in: {
            $map: {
                input: { $range: [0, { $size: '$$retained' }] },
                as: 'itemIndex',
                in: {
                    $mergeObjects: [
                        { $arrayElemAt: ['$$retained', '$$itemIndex'] },
                        { order: '$$itemIndex' }
                    ]
                }
            }
        }
    }
});

const deleteTargetAndDetachPages = async (
    targetType: 'carousel' | 'contentCollection',
    targetId: string,
    updatedBy: string,
    hooks: PageTargetDeletionHooks = {}
) => {
    let canonicalTargetId: string;
    try {
        canonicalTargetId = canonicalObjectId(targetId);
    } catch {
        return false;
    }
    const canonicalUpdatedBy = canonicalObjectId(updatedBy);
    const targetObjectId = ObjectId.createFromHexString(canonicalTargetId);
    const collectionName = targetType === 'carousel' ? 'carousels' : 'contentCollections';
    const pageReferenceField = targetType === 'carousel' ? 'carouselId' : 'collectionId';
    const referenceVariants = [
        canonicalTargetId,
        canonicalTargetId.toUpperCase(),
        targetObjectId
    ];
    const session = getDatabaseClient().startSession();
    let deleted = false;
    try {
        await session.withTransaction(async () => {
            await touchActiveAccount(canonicalUpdatedBy, session);
            const fenced = await getDb()!.collection(collectionName).updateOne(
                { _id: targetObjectId },
                { $inc: { referenceRevision: 1 } },
                { session }
            );
            if (fenced.matchedCount !== 1) {
                deleted = false;
                return;
            }
            await hooks.afterTargetFence?.();
            await getDb()!.collection('pages').updateMany(
                { [`items.${pageReferenceField}`]: { $in: referenceVariants } },
                [{
                    $set: {
                        items: normalizedPageItemsWithout(pageReferenceField, canonicalTargetId),
                        updatedBy: canonicalUpdatedBy,
                        updatedAt: new Date()
                    }
                }],
                { session }
            );
            const removed = await getDb()!.collection(collectionName).deleteOne(
                { _id: targetObjectId },
                { session }
            );
            if (removed.deletedCount !== 1) {
                throw new Error(`The ${targetType} changed during deletion.`);
            }
            deleted = true;
        });
    } finally {
        await session.endSession();
    }
    return deleted;
};

/** Atomically detaches every Page reference and deletes the exact Carousel. */
export const deleteCarouselAndPageReferences = (
    carouselId: string,
    updatedBy: string,
    hooks?: PageTargetDeletionHooks
) => deleteTargetAndDetachPages('carousel', carouselId, updatedBy, hooks);

/** Atomically detaches every Page reference and deletes the exact Grid/List. */
export const deleteContentCollectionAndPageReferences = (
    collectionId: string,
    updatedBy: string,
    hooks?: PageTargetDeletionHooks
) => deleteTargetAndDetachPages('contentCollection', collectionId, updatedBy, hooks);
