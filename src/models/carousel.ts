import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { ActivitySource, UserLibrary } from './userLibrary';
import {
    readyArtistLifecycleFilter,
    withReadyArtistReferences
} from '../services/artistReferenceFenceService';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { readyAlbumLifecycleFilter } from '../services/albumReferenceFenceService';
import {
    withReadyCatalogItemReferences
} from '../services/catalogItemReferenceFenceService';
import {
    touchActiveAccount,
    withActiveAccount
} from '../services/accountReferenceFenceService';
import { artistAlbumSection } from '../services/artistAlbumClassificationService';
import { deleteCarouselAndPageReferences } from '../services/pageReferenceLifecycleService';
import { mutateManualComposition, type ManualCompositionHooks } from '../services/manualCompositionService';

const collectionId = 'carousels';
const maximumManualCarouselItems = 500;
const readyAudioFilter = readyAudioStorageFilter;
const toObjectId = (value: string) => {
    try {
        return ObjectId.createFromHexString(value);
    } catch {
        return null;
    }
};

export type CarouselContentType = 'post' | 'album' | 'audioTrack';
export type CarouselMode = 'manual' | 'artist' | 'personalized';
export type ArtistCarouselContentType = 'album' | 'audioTrack';
export type ArtistCarouselSort = 'releaseDateDesc' | 'titleAsc';
export type ArtistCarouselScope = 'discography' | 'collaborations' | 'appearsOn' | 'allRelated';

export interface ArtistCarouselConfig {
    artistId: string;
    contentType: ArtistCarouselContentType;
    scope?: ArtistCarouselScope;
    sort: ArtistCarouselSort;
    limit: number;
}

export interface PersonalizedCarouselConfig {
    source: ActivitySource;
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
    personalizedConfig?: PersonalizedCarouselConfig;
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
        personalizedConfig?: PersonalizedCarouselConfig,
        createdAt: Date = new Date(),
        updatedAt: Date = new Date()
    ) {
        this.name = name;
        this.items = normalizeOrder(items);
        this.mode = mode;
        if (mode === 'artist' && artistConfig) this.artistConfig = artistConfig;
        if (mode === 'personalized' && personalizedConfig) this.personalizedConfig = personalizedConfig;
        this.createdBy = createdBy;
        this.updatedBy = updatedBy;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    save() {
        const db = getDb();
        if (this.mode === 'artist' && this.artistConfig) {
            return withReadyArtistReferences(
                [this.artistConfig.artistId],
                async (session, [artistId]) => {
                    this.artistConfig = { ...this.artistConfig!, artistId };
                    await touchActiveAccount(this.createdBy, session);
                    return db!.collection(collectionId).insertOne(this, { session });
                }
            );
        }
        if (this.mode === 'manual') {
            return withReadyCatalogItemReferences(this.items, async (session, items) => {
                this.items = normalizeOrder(items as unknown as CarouselItemRef[]);
                await touchActiveAccount(this.createdBy, session);
                return db!.collection(collectionId).insertOne(this, { session });
            });
        }
        return withActiveAccount(
            this.createdBy,
            (session) => db!.collection(collectionId).insertOne(this, { session })
        );
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
            .then((carousels) => this.resolveCarousels(carousels, createdBy));
    }

    /** Returns a stable global Carousel inventory slice for administrator workflows. */
    static fetchAll(limit: number = 100, offset: number = 0, viewerUserId?: string) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find()
            .sort({ updatedAt: -1, _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray()
            .then((carousels) => this.resolveCarousels(carousels, viewerUserId));
    }

    static fetchByIds(carouselIds: string[], viewerUserId?: string) {
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
            .then((carousels) => this.resolveCarousels(carousels, viewerUserId));
    }

    static async resolveCarousel(carousel: any, viewerUserId?: string) {
        const mode: CarouselMode = carousel?.mode === 'artist'
            ? 'artist'
            : carousel?.mode === 'personalized' ? 'personalized' : 'manual';
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

        if (mode === 'personalized') {
            const config = carousel?.personalizedConfig as PersonalizedCarouselConfig | undefined;
            if (!viewerUserId || !config || (config.source !== 'recentlySaved' && config.source !== 'recentlyPlayed')) {
                return { ...carousel, mode, items: [] };
            }
            const itemLimit = Math.max(1, Math.min(Number(config.limit ?? 20) || 20, 20));
            const entries = await UserLibrary.recent(viewerUserId, config.source, 20);
            const db = getDb()!;
            const albumIds = entries
                .filter((entry) => entry.contentType === 'album')
                .map((entry) => toObjectId(entry.contentId))
                .filter((id): id is ObjectId => id !== null);
            const audioTrackIds = entries
                .filter((entry) => entry.contentType === 'audioTrack')
                .map((entry) => toObjectId(entry.contentId))
                .filter((id): id is ObjectId => id !== null);
            const [albums, audioTracks] = await Promise.all([
                albumIds.length > 0
                    ? db.collection('albums').find({
                        _id: { $in: albumIds },
                        ...readyAlbumLifecycleFilter
                    })
                        .project({ _id: 1 }).maxTimeMS(3_000).toArray()
                    : [],
                audioTrackIds.length > 0
                    ? db.collection('audioTracks').find({
                        ...readyAudioFilter,
                        _id: { $in: audioTrackIds }
                    })
                        .project({ _id: 1 }).maxTimeMS(3_000).toArray()
                    : []
            ]);
            const validKeys = new Set([
                ...albums.map((item) => `album:${item._id}`),
                ...audioTracks.map((item) => `audioTrack:${item._id}`)
            ]);
            const validItems: CarouselItemRef[] = entries
                .filter((entry) => validKeys.has(`${entry.contentType}:${entry.contentId}`))
                .slice(0, itemLimit)
                .map((entry, order) => ({
                    contentType: entry.contentType,
                    contentId: entry.contentId,
                    order
                }));
            return { ...carousel, mode, items: validItems };
        }

        const config = carousel?.artistConfig as ArtistCarouselConfig | undefined;
        const artistObjectId = config ? toObjectId(config.artistId) : null;
        if (!config || !artistObjectId) {
            return { ...carousel, mode, items: [] };
        }

        const db = getDb();
        const artist: any = await db!
            .collection('artists')
            .find({ _id: artistObjectId, ...readyArtistLifecycleFilter })
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
                title: 1 as const,
                _id: 1 as const
            };
        let content: any[] = [];
        if (config.contentType === 'album') {
            const artistId = artistObjectId.toHexString();
            const artistValues = [artistId, artistId.toUpperCase(), artistObjectId];
            const legacyDiscographyIds = (Array.isArray(artist.albumIds) ? artist.albumIds : [])
                .map((id: unknown) => toObjectId(String(id))).filter(Boolean);
            const scope = config.scope ?? 'discography';
            // Group in Mongo so prolific Artists do not lose releases behind a track-count cutoff.
            const relatedAlbums = await db!.collection('audioTracks').aggregate<{ _id: unknown }>([
                { $match: { $and: [readyAudioFilter, { $or: [
                    { credits: { $elemMatch: { subjectType: 'artist', subjectId: artistId } } },
                    { artistIds: { $in: artistValues } }
                ] }] } },
                { $group: { _id: '$albumId' } }
            ], { maxTimeMS: 3_000 }).toArray();
            const relatedAlbumIds = relatedAlbums.map(album => toObjectId(String(album._id))).filter(Boolean);
            const cursor = db!.collection('albums').find({ $and: [readyAlbumLifecycleFilter, { $or: [
                { credits: { $elemMatch: { subjectType: 'artist', subjectId: artistId } } },
                { _id: { $in: [...legacyDiscographyIds, ...relatedAlbumIds] } }
            ] }] }).sort(sort).batchSize(100).maxTimeMS(3_000);
            try {
                // Classify before the output limit, so unrelated roles and non-ready Albums cannot consume slots.
                while (content.length < itemLimit && await cursor.hasNext()) {
                    const candidates = [];
                    while (candidates.length < 50 && await cursor.hasNext()) candidates.push((await cursor.next())!);
                    const albumValues = candidates.flatMap(album => [album._id, String(album._id), String(album._id).toUpperCase()]);
                    const tracks = await db!.collection('audioTracks').find({ $and: [readyAudioFilter, {
                        albumId: { $in: albumValues },
                        $or: [
                            { credits: { $elemMatch: { subjectType: 'artist', subjectId: artistId } } },
                            { artistIds: { $in: artistValues } }
                        ]
                    }] }).project({ albumId: 1, credits: 1, attributionStatus: 1, artistIds: 1 })
                        .maxTimeMS(3_000).toArray();
                    const tracksByAlbum = new Map<string, typeof tracks>();
                    for (const track of tracks) {
                        const id = String(track.albumId).toLowerCase();
                        const related = tracksByAlbum.get(id) ?? [];
                        related.push(track);
                        tracksByAlbum.set(id, related);
                    }
                    for (const album of candidates) {
                        const section = artistAlbumSection(artist, album, tracksByAlbum.get(String(album._id)) ?? []);
                        if (section && (scope === 'allRelated' || section === scope)) content.push(album);
                        if (content.length >= itemLimit) break;
                    }
                }
            } finally { await cursor.close(); }
        } else {
            const scope = config.scope ?? 'discography';
            const roles = scope === 'discography'
                ? ['primary']
                : scope === 'collaborations'
                    ? ['featured']
                    : scope === 'appearsOn'
                        ? ['performer', 'legacyUnspecified']
                        : null;
            const creditMatch: Record<string, unknown> = {
                subjectType: 'artist',
                subjectId: config.artistId,
                ...(roles ? { role: { $in: roles } } : {})
            };
            content = await db!
                .collection('audioTracks')
                .find({
                    $and: [
                        readyAudioFilter,
                        { $or: [
                            { credits: { $elemMatch: creditMatch } },
                            ...((scope === 'allRelated' || scope === 'appearsOn')
                                ? [{ artistIds: { $in: [config.artistId, artistObjectId] } }]
                                : scope === 'discography'
                                    ? [{
                                        credits: { $exists: false },
                                        artistIds: { $in: [config.artistId, artistObjectId] }
                                    }]
                                    : [])
                        ] }
                    ]
                })
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

    static async resolveCarousels(carousels: any[], viewerUserId?: string) {
        const resolved: any[] = [];
        for (let index = 0; index < carousels.length; index += 10) {
            resolved.push(...await Promise.all(
                carousels.slice(index, index + 10).map((carousel) => this.resolveCarousel(carousel, viewerUserId))
            ));
        }
        return resolved;
    }

    static updateById(carouselId: string, update: Record<string, unknown>) {
        const db = getDb();
        const carouselObjectId = ObjectId.createFromHexString(carouselId);
        const persist = (normalizedUpdate: Record<string, unknown>, session?: ClientSession) => db!
            .collection(collectionId)
            .updateOne(
                { _id: carouselObjectId },
                {
                    $set: {
                        ...normalizedUpdate,
                        updatedAt: new Date()
                    }
                },
                session ? { session } : {}
            );
        const artistConfig = update.mode === 'artist'
            ? update.artistConfig as ArtistCarouselConfig | undefined
            : undefined;
        if (artistConfig) {
            return withReadyArtistReferences(
                [artistConfig.artistId],
                (session, [artistId]) => persist({
                    ...update,
                    artistConfig: { ...artistConfig, artistId },
                    items: []
                }, session)
            );
        }
        if (Array.isArray(update.items)) {
            return withReadyCatalogItemReferences(
                update.items as CarouselItemRef[],
                (session, items) => persist({ ...update, items }, session)
            );
        }
        return persist(update);
    }

    /** Appends retry against the current contents; positional edits reject a changed snapshot. */
    static async addItem(carouselId: string, item: Omit<CarouselItemRef, 'order'>, updatedBy: string, position?: number, hooks: ManualCompositionHooks = {}) {
        const result = await mutateManualComposition<CarouselItemRef>(collectionId, [carouselId], updatedBy, ([existing]) => {
            const items = Array.isArray(existing.items) ? [...existing.items] : [];
            if (items.length >= maximumManualCarouselItems || (position !== undefined && !Number.isInteger(position))) return null;
            const insertAt = position === undefined ? items.length : Math.max(0, Math.min(position, items.length));
            items.splice(insertAt, 0, { ...item, order: insertAt });
            return [items];
        }, position !== undefined, hooks);
        return result?.[0] ?? null;
    }

    static async reorderItem(carouselId: string, fromIndex: number, toIndex: number, updatedBy: string, hooks: ManualCompositionHooks = {}) {
        const result = await mutateManualComposition<CarouselItemRef>(collectionId, [carouselId], updatedBy, ([existing]) => {
            const items = Array.isArray(existing.items) ? [...existing.items] : [];
            if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
                || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return null;
            return [moveByIndex(items, fromIndex, toIndex)];
        }, true, hooks);
        return result?.[0] ?? null;
    }

    /** Moves both sides atomically and never reinterprets a stale source index on transaction retry. */
    static async moveItemBetweenCarousels(sourceCarouselId: string, targetCarouselId: string, fromIndex: number, toIndex: number, updatedBy: string, hooks: ManualCompositionHooks = {}) {
        const result = await mutateManualComposition<CarouselItemRef>(collectionId, [sourceCarouselId, targetCarouselId], updatedBy, ([source, target]) => {
            const sourceItems = Array.isArray(source.items) ? [...source.items] : [];
            const targetItems = Array.isArray(target.items) ? [...target.items] : [];
            if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
                || fromIndex < 0 || fromIndex >= sourceItems.length || targetItems.length >= maximumManualCarouselItems) return null;
            const [movedItem] = sourceItems.splice(fromIndex, 1);
            targetItems.splice(Math.max(0, Math.min(toIndex, targetItems.length)), 0, movedItem);
            return [sourceItems, targetItems];
        }, true, hooks);
        return result ? { sourceItems: result[0], targetItems: result[1] } : null;
    }

    /** Preserves selected source order while committing the entire batch in one transaction. */
    static async moveItemsBetweenCarousels(sourceCarouselId: string, targetCarouselId: string, fromIndexes: number[], updatedBy: string, hooks: ManualCompositionHooks = {}) {
        const result = await mutateManualComposition<CarouselItemRef>(collectionId, [sourceCarouselId, targetCarouselId], updatedBy, ([source, target]) => {
            const sourceItems = (Array.isArray(source.items) ? [...source.items] : [])
                .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
            const targetItems = (Array.isArray(target.items) ? [...target.items] : [])
                .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
            const selectedIndexes = [...new Set(fromIndexes)].sort((a, b) => a - b);
            if (selectedIndexes.length === 0 || selectedIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= sourceItems.length)
                || targetItems.length + selectedIndexes.length > maximumManualCarouselItems) return null;
            const selected = new Set(selectedIndexes);
            return [sourceItems.filter((_, index) => !selected.has(index)), [...targetItems, ...selectedIndexes.map(index => sourceItems[index])]];
        }, true, hooks);
        return result ? { sourceItems: result[0], targetItems: result[1] } : null;
    }

    /** Deletes a Carousel only through the atomic Page-detachment lifecycle. */
    static deleteById(carouselId: string, updatedBy: string) {
        return deleteCarouselAndPageReferences(carouselId, updatedBy);
    }
}
