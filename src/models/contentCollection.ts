import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { withReadyCatalogItemReferences } from '../services/catalogItemReferenceFenceService';
import {
    touchActiveAccount,
    withActiveAccount
} from '../services/accountReferenceFenceService';
import { deleteContentCollectionAndPageReferences } from '../services/pageReferenceLifecycleService';

const collectionId = 'contentCollections';
const maximumManualItems = 500;

export type CollectionPresentation = 'grid' | 'list';
export type CollectionMode = 'manual' | 'dynamic';
export type CollectionContentType = 'album' | 'audioTrack';
export type CollectionDynamicSource = 'downloadedAlbums' | 'downloadedSongs';

export interface ContentCollectionItemRef {
    contentType: CollectionContentType;
    contentId: string;
    order: number;
}

const normalizeOrder = (items: ContentCollectionItemRef[]) => items.map((item, order) => ({
    ...item,
    order
}));

const moveByIndex = <T>(items: T[], fromIndex: number, toIndex: number) => {
    const copy = [...items];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, moved);
    return copy;
};

/** Reusable homogeneous Grid/List definition; device-local sources resolve in the client. */
export class ContentCollection {
    name: string;
    presentation: CollectionPresentation;
    mode: CollectionMode;
    contentType: CollectionContentType;
    dynamicSource?: CollectionDynamicSource;
    items: ContentCollectionItemRef[];
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;

    constructor(
        name: string,
        presentation: CollectionPresentation,
        mode: CollectionMode,
        contentType: CollectionContentType,
        items: ContentCollectionItemRef[],
        createdBy: string,
        updatedBy: string,
        dynamicSource?: CollectionDynamicSource,
        createdAt: Date = new Date(),
        updatedAt: Date = new Date()
    ) {
        this.name = name;
        this.presentation = presentation;
        this.mode = mode;
        this.contentType = contentType;
        this.items = mode === 'manual' ? normalizeOrder(items) : [];
        if (mode === 'dynamic' && dynamicSource) this.dynamicSource = dynamicSource;
        this.createdBy = createdBy;
        this.updatedBy = updatedBy;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    save() {
        if (this.mode === 'manual') {
            return withReadyCatalogItemReferences(this.items, async (session, items) => {
                this.items = normalizeOrder(items as unknown as ContentCollectionItemRef[]);
                await touchActiveAccount(this.createdBy, session);
                return getDb()!.collection(collectionId).insertOne(this, { session });
            });
        }
        return withActiveAccount(
            this.createdBy,
            (session) => getDb()!.collection(collectionId).insertOne(this, { session })
        );
    }

    static findById(id: string) {
        return getDb()!.collection(collectionId)
            .find({ _id: ObjectId.createFromHexString(id) })
            .next();
    }

    static fetchByCreator(createdBy: string, limit: number = 100) {
        return getDb()!.collection(collectionId)
            .find({ createdBy })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .toArray();
    }

    /** Returns a stable global Grid/List inventory slice for administrator workflows. */
    static fetchAll(limit: number = 100, offset: number = 0) {
        return getDb()!.collection(collectionId)
            .find()
            .sort({ updatedAt: -1, _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray();
    }

    static fetchByIds(ids: string[]) {
        const objectIds = ids.filter(Boolean).map((id) => ObjectId.createFromHexString(id));
        if (objectIds.length === 0) return Promise.resolve([]);
        return getDb()!.collection(collectionId)
            .find({ _id: { $in: objectIds } })
            .toArray();
    }

    static async addItem(
        id: string,
        item: Omit<ContentCollectionItemRef, 'order'>,
        updatedBy: string,
        position?: number
    ) {
        const existing: any = await this.findById(id);
        if (!existing || existing.mode !== 'manual' || existing.contentType !== item.contentType) {
            return null;
        }
        const nextItems = Array.isArray(existing.items) ? [...existing.items] : [];
        if (nextItems.length >= maximumManualItems) return null;
        const insertAt = typeof position === 'number'
            ? Math.max(0, Math.min(position, nextItems.length))
            : nextItems.length;
        nextItems.splice(insertAt, 0, { ...item, order: insertAt });
        const items = normalizeOrder(nextItems);
        await withReadyCatalogItemReferences(items, async (session, normalizedItems) => {
            await getDb()!.collection(collectionId).updateOne(
                { _id: ObjectId.createFromHexString(id), mode: 'manual' },
                { $set: { items: normalizedItems, updatedBy, updatedAt: new Date() } },
                { session }
            );
        });
        return items;
    }

    static async reorderItem(id: string, fromIndex: number, toIndex: number, updatedBy: string) {
        const existing: any = await this.findById(id);
        if (!existing || existing.mode !== 'manual') return null;
        const items = Array.isArray(existing.items) ? [...existing.items] : [];
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
            return null;
        }
        const reordered = normalizeOrder(moveByIndex(items, fromIndex, toIndex));
        await withReadyCatalogItemReferences(reordered, async (session, normalizedItems) => {
            await getDb()!.collection(collectionId).updateOne(
                { _id: ObjectId.createFromHexString(id), mode: 'manual' },
                { $set: { items: normalizedItems, updatedBy, updatedAt: new Date() } },
                { session }
            );
        });
        return reordered;
    }

    /** Deletes a Grid/List only through the atomic Page-detachment lifecycle. */
    static deleteById(id: string, updatedBy: string) {
        return deleteContentCollectionAndPageReferences(id, updatedBy);
    }
}
