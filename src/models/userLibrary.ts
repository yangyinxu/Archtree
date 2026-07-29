import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

export type LibraryContentType = 'album' | 'audioTrack';
export type ActivitySource = 'recentlySaved' | 'recentlyPlayed';

export interface ActivityEntry {
    contentType: LibraryContentType;
    contentId: string;
    occurredAt: Date;
}

const savesCollection = 'userSaves';
const activityCollection = 'userActivity';
const maximumRecentItems = 20;

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
            .find({ _id: objectId })
            .project({ _id: 1 })
            .maxTimeMS(3_000)
            .next());
    }

    static async save(userId: string, contentType: LibraryContentType, contentId: string) {
        const now = new Date();
        await getDb()!.collection(savesCollection).updateOne(
            { userId, contentType, contentId },
            { $setOnInsert: { userId, contentType, contentId, savedAt: now } },
            { upsert: true }
        );
        await this.recordActivity(userId, 'recentlySaved', [{ contentType, contentId, occurredAt: now }]);
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
        await this.recordActivity(userId, 'recentlyPlayed', [{
            contentType,
            contentId,
            occurredAt: new Date()
        }]);
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
        await Promise.all([
            db.collection(savesCollection).deleteMany({ contentType, contentId }),
            db.collection(activityCollection).updateMany(
                {},
                {
                    $pull: {
                        recentlySaved: { contentType, contentId },
                        recentlyPlayed: { contentType, contentId }
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

    private static async recordActivity(userId: string, source: ActivitySource, entries: ActivityEntry[]) {
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
            { upsert: true }
        );
    }
}
