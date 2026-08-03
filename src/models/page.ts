import { getDb } from '../infrastructure/database';

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

    save() {
        const db = getDb();

        return db!
            .collection(collectionId)
            .insertOne(this);
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

        return db!
            .collection(collectionId)
            .updateOne(
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
                { upsert: true }
            );
    }

    static async addCarouselItem(slug: PageSlug, carouselId: string, updatedBy: string, position?: number) {
        const page: any = await this.findBySlug(slug);
        if (!page) {
            return null;
        }

        const nextItems = Array.isArray(page.items) ? [...page.items] : [];
        if (nextItems.length >= maximumPageItems) {
            return null;
        }
        const insertAt = typeof position === 'number'
            ? Math.max(0, Math.min(position, nextItems.length))
            : nextItems.length;

        nextItems.splice(insertAt, 0, {
            itemType: 'carousel',
            carouselId,
            order: insertAt
        });

        const normalizedItems = normalizeOrder(nextItems);

        const db = getDb();
        await db!
            .collection(collectionId)
            .updateOne(
                { slug },
                {
                    $set: {
                        items: normalizedItems,
                        updatedBy,
                        updatedAt: new Date()
                    }
                }
            );

        return normalizedItems;
    }

    static async addCollectionItem(
        slug: PageSlug,
        itemType: 'grid' | 'list',
        collectionRefId: string,
        updatedBy: string,
        position?: number
    ) {
        const page: any = await this.findBySlug(slug);
        if (!page) return null;
        const nextItems = Array.isArray(page.items) ? [...page.items] : [];
        if (nextItems.length >= maximumPageItems) return null;
        const insertAt = typeof position === 'number'
            ? Math.max(0, Math.min(position, nextItems.length))
            : nextItems.length;
        nextItems.splice(insertAt, 0, {
            itemType,
            collectionId: collectionRefId,
            order: insertAt
        });
        const items = normalizeOrder(nextItems);
        await getDb()!.collection(collectionId).updateOne(
            { slug },
            { $set: { items, updatedBy, updatedAt: new Date() } }
        );
        return items;
    }

    static async removeCarouselItem(slug: PageSlug, carouselId: string, updatedBy: string) {
        const page: any = await this.findBySlug(slug);
        if (!page) {
            return null;
        }

        const nextItems = Array.isArray(page.items)
            ? page.items.filter((item: PageItemRef) =>
                item.itemType !== 'carousel' || item.carouselId !== carouselId
            )
            : [];

        const normalizedItems = normalizeOrder(nextItems);

        const db = getDb();
        await db!
            .collection(collectionId)
            .updateOne(
                { slug },
                {
                    $set: {
                        items: normalizedItems,
                        updatedBy,
                        updatedAt: new Date()
                    }
                }
            );

        return normalizedItems;
    }

    static async removeCollectionItem(slug: PageSlug, collectionRefId: string, updatedBy: string) {
        const page: any = await this.findBySlug(slug);
        if (!page) return null;
        const nextItems = Array.isArray(page.items)
            ? page.items.filter((item: PageItemRef) =>
                item.itemType === 'carousel' || item.collectionId !== collectionRefId
            )
            : [];
        const items = normalizeOrder(nextItems);
        await getDb()!.collection(collectionId).updateOne(
            { slug },
            { $set: { items, updatedBy, updatedAt: new Date() } }
        );
        return items;
    }

    static async reorderItem(slug: PageSlug, fromIndex: number, toIndex: number, updatedBy: string) {
        const page: any = await this.findBySlug(slug);
        if (!page) {
            return null;
        }

        const nextItems = Array.isArray(page.items) ? [...page.items] : [];
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= nextItems.length || toIndex >= nextItems.length) {
            return null;
        }

        const reordered = moveByIndex(nextItems, fromIndex, toIndex);
        const normalizedItems = normalizeOrder(reordered);

        const db = getDb();
        await db!
            .collection(collectionId)
            .updateOne(
                { slug },
                {
                    $set: {
                        items: normalizedItems,
                        updatedBy,
                        updatedAt: new Date()
                    }
                }
            );

        return normalizedItems;
    }

    static detachCarouselFromAllPages(carouselId: string, updatedBy: string) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .updateMany(
                { 'items.carouselId': carouselId },
                {
                    $pull: {
                        items: {
                            carouselId
                        }
                    } as any,
                    $set: {
                        updatedBy,
                        updatedAt: new Date()
                    }
                }
            );
    }

    static detachCollectionFromAllPages(collectionRefId: string, updatedBy: string) {
        return getDb()!.collection(collectionId).updateMany(
            { 'items.collectionId': collectionRefId },
            {
                $pull: { items: { collectionId: collectionRefId } } as any,
                $set: { updatedBy, updatedAt: new Date() }
            }
        );
    }
}
