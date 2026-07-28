import { getDb } from '../infrastructure/database';

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const reconcileContentReferences = async () => {
    const db = getDb()!;
    const limit = positiveInteger(process.env.MAX_RECONCILIATION_OBJECTS, 50_000);
    const [albums, tracks, artists, carousels, saves, activities] = await Promise.all([
        db.collection('albums').find().project({ audioTrackIds: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('audioTracks').find().project({ albumId: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('artists').find().project({ albumIds: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('carousels').find().project({ mode: 1, items: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('userSaves').find().project({ userId: 1, contentType: 1, contentId: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('userActivity').find().project({ userId: 1, recentlySaved: 1, recentlyPlayed: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray()
    ]);
    const truncated = [albums, tracks, artists, carousels, saves, activities].some((items) => items.length > limit);
    const albumSet = new Set(albums.slice(0, limit).map((item) => String(item._id)));
    const trackSet = new Set(tracks.slice(0, limit).map((item) => String(item._id)));
    const exists = (type: string, id: string) =>
        type === 'album' ? albumSet.has(id) : type === 'audioTrack' ? trackSet.has(id) : true;

    const danglingSaves = saves.slice(0, limit).filter((item) =>
        !exists(String(item.contentType), String(item.contentId))
    );
    const danglingActivity: any[] = [];
    for (const activity of activities.slice(0, limit)) {
        for (const source of ['recentlySaved', 'recentlyPlayed']) {
            for (const entry of Array.isArray(activity[source]) ? activity[source] : []) {
                if (!exists(String(entry.contentType), String(entry.contentId))) {
                    danglingActivity.push({
                        userId: activity.userId,
                        source,
                        contentType: entry.contentType,
                        contentId: entry.contentId
                    });
                }
            }
        }
    }
    const danglingCarouselItems: any[] = [];
    for (const carousel of carousels.slice(0, limit).filter((item) => item.mode === 'manual' || !item.mode)) {
        for (const item of Array.isArray(carousel.items) ? carousel.items : []) {
            if (!exists(String(item.contentType), String(item.contentId))) {
                danglingCarouselItems.push({
                    carouselId: String(carousel._id),
                    contentType: item.contentType,
                    contentId: item.contentId
                });
            }
        }
    }
    const danglingArtistAlbums = artists.slice(0, limit).flatMap((artist) =>
        (Array.isArray(artist.albumIds) ? artist.albumIds : [])
            .filter((id: string) => !albumSet.has(String(id)))
            .map((albumId: string) => ({ artistId: String(artist._id), albumId: String(albumId) }))
    );
    const danglingAlbumTracks = albums.slice(0, limit).flatMap((album) =>
        (Array.isArray(album.audioTrackIds) ? album.audioTrackIds : [])
            .filter((id: string) => !trackSet.has(String(id)))
            .map((audioTrackId: string) => ({ albumId: String(album._id), audioTrackId: String(audioTrackId) }))
    );
    const danglingTrackAlbums = tracks.slice(0, limit)
        .filter((track) => track.albumId && !albumSet.has(String(track.albumId)))
        .map((track) => ({ audioTrackId: String(track._id), albumId: String(track.albumId) }));

    return {
        generatedAt: new Date(),
        readOnly: true,
        truncated,
        limit,
        danglingSaves,
        danglingActivity,
        danglingCarouselItems,
        danglingArtistAlbums,
        danglingAlbumTracks,
        danglingTrackAlbums
    };
};

