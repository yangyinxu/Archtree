import { getDatabaseClient, getDb } from '../infrastructure/database';
import {
    touchActiveAccount,
    withActiveAccount
} from '../services/accountReferenceFenceService';
import {
    PageItemReferenceUnavailableError,
    touchAvailablePageItemReferences
} from '../services/pageReferenceLifecycleService';

const collectionId = 'pages';
const maximumPageItems = 100;

// v1 page surfaces are fixed to Home and Library.
export type PageSlug = 'home' | 'library';

export interface CarouselPageItemRef {
    itemType: 'carousel';
    carouselId: string;
    order: number;
}

export interface CollectionPageItemRef {
    itemType: 'grid' | 'list';
    collectionId: string;
    order: number;
}

export type PageItemRef = CarouselPageItemRef | CollectionPageItemRef;

// Normalize order to a stable 0..N sequence after mutations.
const normalizeOrder = (items: PageItemRef[]) => {
    return items.map((item, index) => ({
        ...item,
        order: index
    }));
};

const moveByIndex = <T>(items: T[], fromIndex: number, toIndex: number) => {
    const copy = [...items];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, moved);
    return copy;
};

export interface PageItemMutationHooks {
    /** Test-only barrier immediately before a newly attached target is touched. */
    beforeReferenceFence?: () => Promise<void>;
    /** Test-only barrier after the Page write and before transaction commit. */
    afterPageWrite?: () => Promise<void>;
}

type PreparedPageMutation = {
    items: PageItemRef[];
    newReferenceIndexes?: number[];
};

/** Reads and writes one Page in a transaction so concurrent detachment cannot be overwritten. */
const mutatePageItems = async (
    slug: PageSlug,
    updatedBy: string,
    prepare: (items: PageItemRef[]) => PreparedPageMutation | null,
    hooks: PageItemMutationHooks = {}
) => {
    const session = getDatabaseClient().startSession();
    let result: PageItemRef[] | null = null;
    try {
        await session.withTransaction(async () => {
            const page: any = await getDb()!.collection(collectionId).findOne({ slug }, { session });
            if (!page) {
                result = null;
                return;
            }
            const prepared = prepare(Array.isArray(page.items) ? [...page.items] : []);
            if (!prepared || prepared.items.length > maximumPageItems) {
                result = null;
                return;
            }
            await touchActiveAccount(updatedBy, session);
            const indexes = prepared.newReferenceIndexes ?? [];
            if (indexes.length > 0) {
                await hooks.beforeReferenceFence?.();
                const normalizedReferences = await touchAvailablePageItemReferences(
                    indexes.map((index) => prepared.items[index]),
                    session
                );
                indexes.forEach((index, referenceIndex) => {
                    prepared.items[index] = normalizedReferences[referenceIndex] as PageItemRef;
                });
            }
            const items = normalizeOrder(prepared.items);
            const updated = await getDb()!.collection(collectionId).updateOne(
                { _id: page._id },
                {
                    $set: {
                        items,
                        updatedBy,
                        updatedAt: new Date()
                    }
                },
                { session }
            );
            if (updated.matchedCount !== 1) {
                throw new Error(`Page ${slug} changed during mutation.`);
            }
            result = items;
            await hooks.afterPageWrite?.();
        });
    } finally {
        await session.endSession();
    }
    return result;
};

// Page stores top-level composition for one screen (home/library).
export class Page {
    slug: PageSlug;
    title: string;
    items: PageItemRef[];
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;

    constructor(slug: PageSlug, title: string, items: PageItemRef[], createdBy: string, updatedBy: string, createdAt: Date = new Date(), updatedAt: Date = new Date()) {
        this.slug = slug;
        this.title = title;
        this.items = normalizeOrder(items);
        this.createdBy = createdBy;
        this.updatedBy = updatedBy;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    async save() {
        if (this.items.length > maximumPageItems) {
            throw new PageItemReferenceUnavailableError();
        }
        const session = getDatabaseClient().startSession();
        let result;
        try {
            await session.withTransaction(async () => {
                await touchActiveAccount(this.createdBy, session);
                this.items = normalizeOrder(
                    await touchAvailablePageItemReferences(this.items, session) as PageItemRef[]
                );
                result = await getDb()!.collection(collectionId).insertOne(this, { session });
            });
        } finally {
            await session.endSession();
        }
        return result!;
    }

    static findBySlug(slug: PageSlug) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ slug })
            .next();
    }

    static fetchByCreator(createdBy: string, limit: number = 20) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ createdBy })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .toArray();
    }

    /** Returns a stable global Page inventory slice without applying provenance filters. */
    static fetchAll(limit: number = 50, offset: number = 0) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find()
            .sort({ updatedAt: -1, _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray();
    }

    static upsertBySlug(slug: PageSlug, title: string, userId: string) {
        const db = getDb();

        return withActiveAccount(
            userId,
            (session) => db!.collection(collectionId).updateOne(
                { slug },
                {
                    $set: {
                        title,
                        updatedBy: userId,
                        updatedAt: new Date()
                    },
                    // Preserve existing items for updates; initialize only on insert.
                    $setOnInsert: {
                        slug,
                        items: [],
                        createdBy: userId,
                        createdAt: new Date()
                    }
                },
                { upsert: true, session }
            )
        );
    }

    static addCarouselItem(
        slug: PageSlug,
        carouselId: string,
        updatedBy: string,
        position?: number,
        hooks: PageItemMutationHooks = {}
    ) {
        return mutatePageItems(slug, updatedBy, (nextItems) => {
            if (nextItems.length >= maximumPageItems) return null;
            const insertAt = typeof position === 'number'
                ? Math.max(0, Math.min(position, nextItems.length))
                : nextItems.length;
            nextItems.splice(insertAt, 0, {
                itemType: 'carousel',
                carouselId,
                order: insertAt
            });
            return { items: nextItems, newReferenceIndexes: [insertAt] };
        }, hooks);
    }

    static async addCollectionItem(
        slug: PageSlug,
        itemType: 'grid' | 'list',
        collectionRefId: string,
        updatedBy: string,
        position?: number,
        hooks: PageItemMutationHooks = {}
    ) {
        return mutatePageItems(slug, updatedBy, (nextItems) => {
            if (nextItems.length >= maximumPageItems) return null;
            const insertAt = typeof position === 'number'
                ? Math.max(0, Math.min(position, nextItems.length))
                : nextItems.length;
            nextItems.splice(insertAt, 0, {
                itemType,
                collectionId: collectionRefId,
                order: insertAt
            });
            return { items: nextItems, newReferenceIndexes: [insertAt] };
        }, hooks);
    }

    static async removeCarouselItem(slug: PageSlug, carouselId: string, updatedBy: string) {
        const canonicalCarouselId = String(carouselId).toLowerCase();
        return mutatePageItems(slug, updatedBy, (items) => ({
            items: items.filter((item: PageItemRef) =>
                item.itemType !== 'carousel'
                    || String(item.carouselId).toLowerCase() !== canonicalCarouselId
            )
        }));
    }

    static async removeCollectionItem(slug: PageSlug, collectionRefId: string, updatedBy: string) {
        const canonicalCollectionId = String(collectionRefId).toLowerCase();
        return mutatePageItems(slug, updatedBy, (items) => ({
            items: items.filter((item: PageItemRef) =>
                item.itemType === 'carousel'
                    || String(item.collectionId).toLowerCase() !== canonicalCollectionId
            )
        }));
    }

    static async reorderItem(slug: PageSlug, fromIndex: number, toIndex: number, updatedBy: string) {
        return mutatePageItems(slug, updatedBy, (items) => {
            if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
                return null;
            }
            return { items: moveByIndex(items, fromIndex, toIndex) };
        });
    }

}
