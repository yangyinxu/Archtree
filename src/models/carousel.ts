import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

const collectionId = 'carousels';
const maximumManualCarouselItems = 500;
const toObjectId = (value: string) => {
    try {
        return ObjectId.createFromHexString(value);
    } catch {
        return null;
    }
};

export type CarouselContentType = 'post' | 'album' | 'audioTrack';
export type CarouselMode = 'manual' | 'artist';
export type ArtistCarouselContentType = 'album' | 'audioTrack';
export type ArtistCarouselSort = 'releaseDateDesc' | 'titleAsc';

export interface ArtistCarouselConfig {
    artistId: string;
    contentType: ArtistCarouselContentType;
    sort: ArtistCarouselSort;
    limit: number;
}

export interface CarouselItemRef {
    contentType: CarouselContentType;
    contentId: string;
    order: number;
}

// Keep persisted order contiguous after insert/move/reorder operations.
const normalizeOrder = (items: CarouselItemRef[]) => {
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

// A reusable, owner-scoped carousel that can host mixed content references.
export class Carousel {
    name: string;
    items: CarouselItemRef[];
    mode: CarouselMode;
    artistConfig?: ArtistCarouselConfig;
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;

    constructor(
        name: string,
        items: CarouselItemRef[],
        createdBy: string,
        updatedBy: string,
        mode: CarouselMode = 'manual',
        artistConfig?: ArtistCarouselConfig,
        createdAt: Date = new Date(),
        updatedAt: Date = new Date()
    ) {
        this.name = name;
        this.items = normalizeOrder(items);
        this.mode = mode;
        if (mode === 'artist' && artistConfig) this.artistConfig = artistConfig;
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

    static findById(carouselId: string) {
        const db = getDb();
        const carouselObjectId = ObjectId.createFromHexString(carouselId);

        return db!
            .collection(collectionId)
            .find({ _id: carouselObjectId })
            .next();
    }

    static fetchByCreator(createdBy: string, limit: number = 100) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ createdBy })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .toArray()
            .then((carousels) => this.resolveCarousels(carousels));
    }

    static fetchByIds(carouselIds: string[]) {
        const db = getDb();
        const objectIds = carouselIds
            .filter(Boolean)
            .map((id) => ObjectId.createFromHexString(id));

        if (objectIds.length === 0) {
            return Promise.resolve([]);
        }

        return db!
            .collection(collectionId)
            .find({ _id: { $in: objectIds } })
            .toArray()
            .then((carousels) => this.resolveCarousels(carousels));
    }

    static async resolveCarousel(carousel: any) {
        const mode: CarouselMode = carousel?.mode === 'artist' ? 'artist' : 'manual';
        if (mode === 'manual') {
            return {
                ...carousel,
                mode,
                items: normalizeOrder(
                    (Array.isArray(carousel?.items) ? [...carousel.items] : [])
                        .sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0))
                        .slice(0, maximumManualCarouselItems)
                )
            };
        }

        const config = carousel?.artistConfig as ArtistCarouselConfig | undefined;
        const artistObjectId = config ? toObjectId(config.artistId) : null;
        if (!config || !artistObjectId) {
            return { ...carousel, mode, items: [] };
        }

        const db = getDb();
        const artist: any = await db!
            .collection('artists')
            .find({ _id: artistObjectId })
            .next();
        if (!artist) {
            return { ...carousel, mode, items: [] };
        }

        const itemLimit = Math.max(1, Math.min(Number(config.limit ?? 20), 100));
        const sort: Record<string, 1 | -1> = config.sort === 'titleAsc'
            ? { title: 1 as const, _id: 1 as const }
            : {
                'releaseDate.year': -1 as const,
                'releaseDate.month': -1 as const,
                'releaseDate.day': -1 as const,
                title: 1 as const
            };
        let content: any[] = [];
        if (config.contentType === 'album') {
            const albumObjectIds = [...new Set<string>(
                (Array.isArray(artist.albumIds) ? artist.albumIds : [])
                    .map(String)
                    .filter((id: string) => Boolean(toObjectId(id)))
            )].map((id) => toObjectId(id)).filter((id): id is ObjectId => id !== null);
            content = albumObjectIds.length > 0
                ? await db!.collection('albums')
                    .find({ _id: { $in: albumObjectIds } })
                    .sort(sort)
                    .limit(itemLimit)
                    .maxTimeMS(3_000)
                    .toArray()
                : [];
        } else {
            content = await db!
                .collection('audioTracks')
                .find({ artistIds: config.artistId })
                .sort(sort)
                .limit(itemLimit)
                .maxTimeMS(3_000)
                .toArray();
        }

        const items = content.map((item, order) => ({
            contentType: config.contentType,
            contentId: String(item._id),
            order
        }));

        return { ...carousel, mode, items };
    }

    static async resolveCarousels(carousels: any[]) {
        const resolved: any[] = [];
        for (let index = 0; index < carousels.length; index += 10) {
            resolved.push(...await Promise.all(
                carousels.slice(index, index + 10).map((carousel) => this.resolveCarousel(carousel))
            ));
        }
        return resolved;
    }

    static updateById(carouselId: string, update: Record<string, unknown>) {
        const db = getDb();
        const carouselObjectId = ObjectId.createFromHexString(carouselId);

        return db!
            .collection(collectionId)
            .updateOne(
                { _id: carouselObjectId },
                {
                    $set: {
                        ...update,
                        updatedAt: new Date()
                    }
                }
            );
    }

    static async addItem(carouselId: string, item: Omit<CarouselItemRef, 'order'>, updatedBy: string, position?: number) {
        const existing: any = await this.findById(carouselId);
        if (!existing || existing.mode === 'artist') {
            return null;
        }

        const nextItems = Array.isArray(existing.items) ? [...existing.items] : [];
        if (nextItems.length >= maximumManualCarouselItems) {
            return null;
        }
        const insertAt = typeof position === 'number'
            ? Math.max(0, Math.min(position, nextItems.length))
            : nextItems.length;

        nextItems.splice(insertAt, 0, {
            ...item,
            order: insertAt
        });

        const normalizedItems = normalizeOrder(nextItems);
        await this.updateById(carouselId, {
            items: normalizedItems,
            updatedBy
        });

        return normalizedItems;
    }

    static async reorderItem(carouselId: string, fromIndex: number, toIndex: number, updatedBy: string) {
        const existing: any = await this.findById(carouselId);
        if (!existing || existing.mode === 'artist') {
            return null;
        }

        const nextItems = Array.isArray(existing.items) ? [...existing.items] : [];
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= nextItems.length || toIndex >= nextItems.length) {
            return null;
        }

        const reordered = moveByIndex(nextItems, fromIndex, toIndex);
        const normalizedItems = normalizeOrder(reordered);

        await this.updateById(carouselId, {
            items: normalizedItems,
            updatedBy
        });

        return normalizedItems;
    }

    static async moveItemBetweenCarousels(sourceCarouselId: string, targetCarouselId: string, fromIndex: number, toIndex: number, updatedBy: string) {
        const source: any = await this.findById(sourceCarouselId);
        const target: any = await this.findById(targetCarouselId);

        if (!source || !target || source.mode === 'artist' || target.mode === 'artist') {
            return null;
        }

        const sourceItems = Array.isArray(source.items) ? [...source.items] : [];
        const targetItems = Array.isArray(target.items) ? [...target.items] : [];
        if (targetItems.length >= maximumManualCarouselItems) {
            return null;
        }

        if (fromIndex < 0 || fromIndex >= sourceItems.length) {
            return null;
        }

        const [movedItem] = sourceItems.splice(fromIndex, 1);
        const insertAt = Math.max(0, Math.min(toIndex, targetItems.length));
        targetItems.splice(insertAt, 0, movedItem);

        // Persist both sides with normalized ordering so clients can render directly.
        await this.updateById(sourceCarouselId, {
            items: normalizeOrder(sourceItems),
            updatedBy
        });

        await this.updateById(targetCarouselId, {
            items: normalizeOrder(targetItems),
            updatedBy
        });

        return {
            sourceItems: normalizeOrder(sourceItems),
            targetItems: normalizeOrder(targetItems)
        };
    }

    static async moveItemsBetweenCarousels(sourceCarouselId: string, targetCarouselId: string, fromIndexes: number[], updatedBy: string) {
        const source: any = await this.findById(sourceCarouselId);
        const target: any = await this.findById(targetCarouselId);

        if (!source || !target || sourceCarouselId === targetCarouselId || source.mode === 'artist' || target.mode === 'artist') {
            return null;
        }

        const sourceItems = (Array.isArray(source.items) ? [...source.items] : [])
            .sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0));
        const targetItems = (Array.isArray(target.items) ? [...target.items] : [])
            .sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0));
        const selectedIndexes = [...new Set(fromIndexes)].sort((a, b) => a - b);
        if (selectedIndexes.length === 0 || selectedIndexes.some((index) => index < 0 || index >= sourceItems.length)) {
            return null;
        }
        if (targetItems.length + selectedIndexes.length > maximumManualCarouselItems) {
            return null;
        }

        const selectedIndexSet = new Set(selectedIndexes);
        const movedItems = selectedIndexes.map((index) => sourceItems[index]);
        const remainingSourceItems = sourceItems.filter((_, index) => !selectedIndexSet.has(index));
        const nextSourceItems = normalizeOrder(remainingSourceItems);
        const nextTargetItems = normalizeOrder([...targetItems, ...movedItems]);

        await this.updateById(sourceCarouselId, {
            items: nextSourceItems,
            updatedBy
        });
        await this.updateById(targetCarouselId, {
            items: nextTargetItems,
            updatedBy
        });

        return {
            sourceItems: nextSourceItems,
            targetItems: nextTargetItems
        };
    }

    static deleteById(carouselId: string) {
        const db = getDb();
        const carouselObjectId = ObjectId.createFromHexString(carouselId);

        return db!
            .collection(collectionId)
            .deleteOne({ _id: carouselObjectId });
    }
}
