import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { withReadyCatalogItemReferences } from '../services/catalogItemReferenceFenceService';
import {
    touchActiveAccount,
    withActiveAccount
} from '../services/accountReferenceFenceService';
import { deleteContentCollectionAndPageReferences } from '../services/pageReferenceLifecycleService';
import { mutateManualComposition, type ManualCompositionHooks } from '../services/manualCompositionService';

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
        position?: number,
        hooks: ManualCompositionHooks = {}
    ) {
        const result = await mutateManualComposition<ContentCollectionItemRef>(collectionId, [id], updatedBy, ([existing]) => {
            if (existing.contentType !== item.contentType) return null;
            const items = Array.isArray(existing.items) ? [...existing.items] : [];
            if (items.length >= maximumManualItems || (position !== undefined && !Number.isInteger(position))) return null;
            const insertAt = position === undefined ? items.length : Math.max(0, Math.min(position, items.length));
            items.splice(insertAt, 0, { ...item, order: insertAt });
            return [items];
        }, position !== undefined, hooks);
        return result?.[0] ?? null;
    }

    static async reorderItem(id: string, fromIndex: number, toIndex: number, updatedBy: string, hooks: ManualCompositionHooks = {}) {
        const result = await mutateManualComposition<ContentCollectionItemRef>(collectionId, [id], updatedBy, ([existing]) => {
            const items = Array.isArray(existing.items) ? [...existing.items] : [];
            if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
                || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return null;
            return [moveByIndex(items, fromIndex, toIndex)];
        }, true, hooks);
        return result?.[0] ?? null;
    }

    /** Deletes a Grid/List only through the atomic Page-detachment lifecycle. */
    static deleteById(id: string, updatedBy: string) {
        return deleteContentCollectionAndPageReferences(id, updatedBy);
    }
}
