import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { normalizeAudioTrackText } from './audioTrack';
import { withDerivedCoverArtUrl, withDisplayCoverArtUrl } from '../utils/coverArt';
import { readyArtistLifecycleFilter } from '../services/artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from '../services/albumReferenceFenceService';
import { withReadyCatalogItemReferences } from '../services/catalogItemReferenceFenceService';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { touchActiveAccount } from '../services/accountReferenceFenceService';

export type LibraryContentType = 'album' | 'audioTrack';
export type ActivitySource = 'recentlySaved' | 'recentlyPlayed';
export type LibrarySort = 'recentActivity' | 'recentlySaved' | 'recentlyPlayed';

export interface ActivityEntry {
    contentType: LibraryContentType;
    contentId: string;
    occurredAt: Date;
}

const savesCollection = 'userSaves';
const activityCollection = 'userActivity';
const maximumRecentItems = 20;
const maximumLibraryPageSize = 100;

interface LibraryCursor {
    sortAt: string | null;
    id: string;
}

export interface LibraryListOptions {
    contentTypes?: LibraryContentType[];
    sort?: LibrarySort;
    limit?: number;
    cursor?: string;
}

export const isLibraryContentType = (value: string): value is LibraryContentType =>
    value === 'album' || value === 'audioTrack';

export const normalizeLibraryContentId = (value: string) => {
    try {
        return ObjectId.createFromHexString(String(value).trim()).toHexString();
    } catch {
        return null;
    }
};

const backingCollection = (contentType: LibraryContentType) =>
    contentType === 'album' ? 'albums' : 'audioTracks';

export class UserLibrary {
    static async contentExists(contentType: LibraryContentType, contentId: string) {
        const normalized = normalizeLibraryContentId(contentId);
        if (!normalized) return false;
        const objectId = ObjectId.createFromHexString(normalized);
        return Boolean(await getDb()!
            .collection(backingCollection(contentType))
            .find({
                _id: objectId,
                ...(contentType === 'album'
                    ? readyAlbumLifecycleFilter
                    : readyAudioStorageFilter)
            })
            .project({ _id: 1 })
            .maxTimeMS(3_000)
            .next());
    }

    static async save(userId: string, contentType: LibraryContentType, contentId: string) {
        const now = new Date();
        await withReadyCatalogItemReferences(
            [{ contentType, contentId }],
            async (session, [reference]) => {
                await touchActiveAccount(userId, session);
                const normalizedContentId = String(reference.contentId);
                await getDb()!.collection(savesCollection).updateOne(
                    { userId, contentType, contentId: normalizedContentId },
                    {
                        $setOnInsert: {
                            userId,
                            contentType,
                            contentId: normalizedContentId,
                            savedAt: now,
                            lastActivityAt: now
                        }
                    },
                    { upsert: true, session }
                );
                await this.recordActivity(userId, 'recentlySaved', [{
                    contentType,
                    contentId: normalizedContentId,
                    occurredAt: now
                }], session);
            }
        );
    }

    static async unsave(userId: string, contentType: LibraryContentType, contentId: string) {
        await getDb()!.collection(savesCollection).deleteOne({ userId, contentType, contentId });
        await getDb()!.collection(activityCollection).updateOne(
            { userId },
            { $pull: { recentlySaved: { contentType, contentId } } } as any
        );
    }

    static async statuses(userId: string, items: Array<{ contentType: LibraryContentType; contentId: string }>) {
        if (items.length === 0) return [];
        const saved = await getDb()!
            .collection(savesCollection)
            .find({ userId, $or: items })
            .project({ contentType: 1, contentId: 1 })
            .limit(100)
            .toArray();
        const keys = new Set(saved.map((item) => `${item.contentType}:${item.contentId}`));
        return items.map((item) => ({
            ...item,
            saved: keys.has(`${item.contentType}:${item.contentId}`)
        }));
    }

    static async recordPlayed(userId: string, contentType: LibraryContentType, contentId: string) {
        const now = new Date();
        await withReadyCatalogItemReferences(
            [{ contentType, contentId }],
            async (session, [reference]) => {
                await touchActiveAccount(userId, session);
                const normalizedContentId = String(reference.contentId);
                // Only saved items belong to the server Library. Recent playback history
                // still records unsaved items through the existing bounded activity list.
                await getDb()!.collection(savesCollection).updateOne(
                    { userId, contentType, contentId: normalizedContentId },
                    { $set: { lastPlayedAt: now, lastActivityAt: now } },
                    { session }
                );
                await this.recordActivity(userId, 'recentlyPlayed', [{
                    contentType,
                    contentId: normalizedContentId,
                    occurredAt: now
                }], session);
            }
        );
    }

    static async list(userId: string, options: LibraryListOptions = {}) {
        const sort = options.sort ?? 'recentActivity';
        const limit = Math.max(1, Math.min(options.limit ?? 50, maximumLibraryPageSize));
        const cursor = this.decodeLibraryCursor(options.cursor);
        const contentTypes = [...new Set(options.contentTypes ?? [])]
            .filter(isLibraryContentType);
        const match: Record<string, unknown> = { userId };
        if (contentTypes.length > 0) match.contentType = { $in: contentTypes };

        const sortExpression = sort === 'recentlySaved'
            ? '$savedAt'
            : sort === 'recentlyPlayed'
                ? '$lastPlayedAt'
                : { $ifNull: ['$lastActivityAt', '$savedAt'] };
        const pipeline: Record<string, unknown>[] = [
            { $match: match },
            { $addFields: { librarySortAt: sortExpression } }
        ];
        if (cursor) {
            const cursorId = ObjectId.createFromHexString(cursor.id);
            pipeline.push(cursor.sortAt
                ? {
                    $match: {
                        $or: [
                            { librarySortAt: { $lt: new Date(cursor.sortAt) } },
                            {
                                librarySortAt: new Date(cursor.sortAt),
                                _id: { $lt: cursorId }
                            },
                            { librarySortAt: null }
                        ]
                    }
                }
                : {
                    $match: {
                        librarySortAt: null,
                        _id: { $lt: cursorId }
                    }
                });
        }
        pipeline.push(
            { $sort: { librarySortAt: -1, _id: -1 } },
            { $limit: limit + 1 }
        );

        const saves: any[] = await getDb()!
            .collection(savesCollection)
            .aggregate(pipeline, { maxTimeMS: 3_000 })
            .toArray();
        const page = saves.slice(0, limit);
        const albumIds = page
            .filter((item) => item.contentType === 'album')
            .map((item) => ObjectId.createFromHexString(item.contentId));
        const trackIds = page
            .filter((item) => item.contentType === 'audioTrack')
            .map((item) => ObjectId.createFromHexString(item.contentId));
        const db = getDb()!;
        const [albums, tracks] = await Promise.all([
            albumIds.length > 0
                ? db.collection('albums').find({
                    _id: { $in: albumIds },
                    ...readyAlbumLifecycleFilter
                }).maxTimeMS(3_000).toArray()
                : [],
            trackIds.length > 0
                ? db.collection('audioTracks').find({
                    // Existing saves remain visible when their audio becomes
                    // unavailable; the listener projection disables playback.
                    _id: { $in: trackIds }
                }).maxTimeMS(3_000).toArray()
                : []
        ]);
        const linkedAlbumIds = tracks
            .map((track: any) => String(track.albumId ?? ''))
            .filter((id) => ObjectId.isValid(id));
        const linkedAlbums = linkedAlbumIds.length > 0
            ? await db.collection('albums').find({
                _id: { $in: linkedAlbumIds.map((id) => ObjectId.createFromHexString(id)) },
                ...readyAlbumLifecycleFilter
            }).maxTimeMS(3_000).toArray()
            : [];
        const trackArtistIds = tracks.flatMap((track: any) =>
            (Array.isArray(track.artistIds) ? track.artistIds : [])
                .map(String)
                .filter((id: string) => ObjectId.isValid(id))
        );
        const artistQueries: Record<string, unknown>[] = [];
        if (trackArtistIds.length > 0) {
            artistQueries.push({
                _id: { $in: trackArtistIds.map((id) => ObjectId.createFromHexString(id)) }
            });
        }
        if (albumIds.length > 0) {
            artistQueries.push({ albumIds: { $in: albumIds.map(String) } });
        }
        const artists = artistQueries.length > 0
            ? await db.collection('artists')
                .find({ $and: [readyArtistLifecycleFilter, { $or: artistQueries }] })
                .maxTimeMS(3_000)
                .toArray()
            : [];
        const artistNamesById = new Map(
            artists.map((artist: any) => [String(artist._id), String(artist.name ?? '')])
        );
        const albumsById = new Map(
            [...albums, ...linkedAlbums].map((album: any) => [String(album._id), album])
        );
        const tracksById = new Map(tracks.map((track: any) => [String(track._id), track]));
        const items = page.map((save): any | null => {
            const common = {
                contentType: save.contentType as LibraryContentType,
                contentId: String(save.contentId),
                savedAt: save.savedAt,
                lastPlayedAt: save.lastPlayedAt ?? null,
                lastActivityAt: save.lastActivityAt ?? save.savedAt
            };
            if (save.contentType === 'album') {
                const album = albumsById.get(String(save.contentId));
                const creator = artists
                    .filter((artist: any) =>
                        (Array.isArray(artist.albumIds) ? artist.albumIds : [])
                            .map(String)
                            .includes(String(save.contentId))
                    )
                    .map((artist: any) => String(artist.name ?? '').trim())
                    .filter(Boolean)
                    .join(', ');
                return album ? {
                    ...common,
                    creator: creator || null,
                    album: withDerivedCoverArtUrl(album)
                } : null;
            }
            const track = tracksById.get(String(save.contentId));
            if (!track) return null;
            const creator = (Array.isArray(track.artistIds) ? track.artistIds : [])
                .map((id: unknown) => artistNamesById.get(String(id))?.trim() ?? '')
                .filter(Boolean)
                .join(', ');
            const linkedAlbum = albumsById.get(String(track.albumId ?? ''));
            return {
                ...common,
                creator: creator || null,
                audioTrack: withDisplayCoverArtUrl(
                    {
                        ...normalizeAudioTrackText(track),
                        albumId: linkedAlbum ? track.albumId : null
                    },
                    linkedAlbum
                )
            };
        }).filter((item): item is any => item !== null);
        const last = page[page.length - 1];
        return {
            items,
            nextCursor: saves.length > limit && last
                ? this.encodeLibraryCursor({
                    sortAt: last.librarySortAt instanceof Date
                        ? last.librarySortAt.toISOString()
                        : null,
                    id: String(last._id)
                })
                : null
        };
    }

    static async recent(userId: string, source: ActivitySource, limit: number = maximumRecentItems) {
        const document: any = await getDb()!
            .collection(activityCollection)
            .find({ userId })
            .project({ [source]: 1 })
            .next();
        const entries: ActivityEntry[] = Array.isArray(document?.[source]) ? document[source] : [];
        return entries.slice(-Math.max(1, Math.min(limit, maximumRecentItems))).reverse();
    }

    static async cleanupContent(contentType: LibraryContentType, contentId: string) {
        const db = getDb()!;
        const contentIds: Array<string | ObjectId> = [];
        if (/^[0-9a-fA-F]{24}$/.test(contentId)) {
            const objectId = ObjectId.createFromHexString(contentId);
            const canonicalContentId = objectId.toHexString();
            contentIds.push(canonicalContentId, canonicalContentId.toUpperCase(), objectId);
            if (contentId !== canonicalContentId) contentIds.push(contentId);
        } else {
            contentIds.push(contentId);
        }
        await Promise.all([
            db.collection(savesCollection).deleteMany({
                contentType,
                contentId: { $in: contentIds }
            }),
            db.collection(activityCollection).updateMany(
                {},
                {
                    $pull: {
                        recentlySaved: { contentType, contentId: { $in: contentIds } },
                        recentlyPlayed: { contentType, contentId: { $in: contentIds } }
                    }
                } as any
            )
        ]);
    }

    /** Removes listener-owned saves and activity during account deletion. */
    static async deleteForUser(userId: string) {
        await Promise.all([
            getDb()!.collection(savesCollection).deleteMany({ userId }),
            getDb()!.collection(activityCollection).deleteMany({ userId })
        ]);
    }

    private static async recordActivity(
        userId: string,
        source: ActivitySource,
        entries: ActivityEntry[],
        session?: ClientSession
    ) {
        const keys = entries.map((entry) => `${entry.contentType}:${entry.contentId}`);
        await getDb()!.collection(activityCollection).updateOne(
            { userId },
            [{
                $set: {
                    userId,
                    [source]: {
                        $slice: [{
                            $concatArrays: [{
                                $filter: {
                                    input: { $ifNull: [`$${source}`, []] },
                                    as: 'entry',
                                    cond: {
                                        $not: [{
                                            $in: [
                                                { $concat: ['$$entry.contentType', ':', '$$entry.contentId'] },
                                                keys
                                            ]
                                        }]
                                    }
                                }
                            }, entries]
                        }, -maximumRecentItems]
                    },
                    updatedAt: new Date()
                }
            }],
            { upsert: true, ...(session ? { session } : {}) }
        );
    }

    private static encodeLibraryCursor(cursor: LibraryCursor) {
        return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    }

    private static decodeLibraryCursor(value?: string): LibraryCursor | null {
        if (!value) return null;
        try {
            const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
            const id = String(parsed?.id ?? '');
            const sortAt = parsed?.sortAt === null ? null : String(parsed?.sortAt ?? '');
            if (!ObjectId.isValid(id) || (sortAt !== null && Number.isNaN(Date.parse(sortAt)))) {
                return null;
            }
            return { id, sortAt };
        } catch {
            return null;
        }
    }
}
