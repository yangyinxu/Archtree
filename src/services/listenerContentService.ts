import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import {
    ActivitySource,
    LibraryListOptions,
    UserLibrary
} from '../models/userLibrary';
import { resolvedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import { normalizeUtf8Text } from '../utils/textEncoding';

export interface ListenerDate {
    year?: number;
    month?: number;
    day?: number;
}

export interface ListenerArtistSummary {
    contentType: 'artist';
    id: string;
    name: string;
    bio: string;
    artworkUrl: string;
}

export interface ListenerAlbumSummary {
    contentType: 'album';
    id: string;
    title: string;
    artworkUrl: string;
    artistNames: string[];
    releaseDate: ListenerDate | null;
}

export interface ListenerAudioTrackSummary {
    contentType: 'audioTrack';
    id: string;
    title: string;
    artworkUrl: string;
    artistNames: string[];
    albumId: string | null;
    albumTitle: string | null;
    duration: string | null;
    streamUrl: string;
}

export type ListenerPlayableSummary = ListenerAlbumSummary | ListenerAudioTrackSummary;
export type ListenerPresentation = 'carousel' | 'grid' | 'list';

export interface ListenerHomeSection {
    id: string;
    title: string;
    presentation: ListenerPresentation;
    items: ListenerPlayableSummary[];
}

interface ListenerContentRef {
    contentType: 'album' | 'audioTrack';
    contentId: string;
    order: number;
}

interface CatalogContext {
    albumsById: Map<string, any>;
    tracksById: Map<string, any>;
    artistsById: Map<string, any>;
    artists: any[];
    albumTrackIds: Map<string, string[]>;
}

const maximumPageItems = 100;
const maximumSectionItems = 500;
const maximumAlbumTracks = 500;
const maximumHydratedAlbumTracks = 10_000;
const queryTimeoutMs = 3_000;

const artistProjection = {
    _id: 1,
    name: 1,
    bio: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    albumIds: 1
};
const albumProjection = {
    _id: 1,
    title: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    audioTrackIds: 1,
    releaseDate: 1
};
const audioTrackProjection = {
    _id: 1,
    title: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    artistIds: 1,
    albumId: 1,
    duration: 1,
    releaseDate: 1
};
const readyAudioFilter = {
    uploadStatus: 'ready',
    s3Key: { $type: 'string', $ne: '' }
};

const isHexObjectId = (value: unknown): value is string =>
    /^[0-9a-fA-F]{24}$/.test(String(value ?? '').trim());

const toObjectId = (value: string) => ObjectId.createFromHexString(value);

const uniqueIds = (values: unknown[], limit = maximumHydratedAlbumTracks) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const id = String(value ?? '').trim();
        if (!isHexObjectId(id) || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= limit) break;
    }
    return result;
};

const normalizeText = (value: unknown) => normalizeUtf8Text(String(value ?? '').trim());

const safeDate = (value: any): ListenerDate | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const date: ListenerDate = {};
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    if (Number.isInteger(year) && year >= 1 && year <= 9_999) date.year = year;
    if (Number.isInteger(month) && month >= 1 && month <= 12) date.month = month;
    if (Number.isInteger(day) && day >= 1 && day <= 31) date.day = day;
    return Object.keys(date).length > 0 ? date : null;
};

const orderedRefs = (items: unknown, limit = maximumSectionItems): ListenerContentRef[] => {
    if (!Array.isArray(items)) return [];
    return [...items]
        .sort((left: any, right: any) => Number(left?.order ?? 0) - Number(right?.order ?? 0))
        .slice(0, limit)
        .flatMap((item: any, index) => {
            const contentType = item?.contentType;
            const contentId = String(item?.contentId ?? '').trim();
            if ((contentType !== 'album' && contentType !== 'audioTrack') || !isHexObjectId(contentId)) {
                return [];
            }
            return [{ contentType, contentId, order: index }];
        });
};

const documentsById = (documents: any[]) => new Map(
    documents
        .filter((document) => document?._id)
        .map((document) => [String(document._id), document] as const)
);

const trackBelongsToAlbum = (track: any, albumId: string) =>
    String(track?.albumId ?? '').trim() === albumId;

const artistReferencesAlbum = (artist: any, albumId: string) =>
    (Array.isArray(artist?.albumIds) ? artist.albumIds : [])
        .some((id: unknown) => String(id) === albumId);

const compareTitleAndId = (left: any, right: any) =>
    normalizeText(left?.title).localeCompare(normalizeText(right?.title))
    || String(left?._id ?? '').localeCompare(String(right?._id ?? ''));

/** Loads only the catalog fields needed to create public listener DTOs. */
const createCatalogContext = async (
    seedAlbums: any[] = [],
    seedTracks: any[] = [],
    seedArtists: any[] = []
): Promise<CatalogContext> => {
    const db = getDb()!;
    const albumsById = documentsById(seedAlbums);
    const tracksById = documentsById(seedTracks);

    const linkedAlbumIds = uniqueIds(
        seedTracks.map((track) => track?.albumId),
        maximumHydratedAlbumTracks
    ).filter((id) => !albumsById.has(id));
    if (linkedAlbumIds.length > 0) {
        const linkedAlbums = await db.collection('albums')
            .find({ _id: { $in: linkedAlbumIds.map(toObjectId) } })
            .project(albumProjection)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
        for (const album of linkedAlbums) albumsById.set(String(album._id), album);
    }

    // Album attribution follows ready component tracks, even on summary surfaces.
    const declaredTrackIds = uniqueIds(
        [...albumsById.values()].flatMap((album) =>
            (Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : [])
                .slice(0, maximumAlbumTracks)
        ),
        maximumHydratedAlbumTracks
    );
    const missingDeclaredTrackIds = declaredTrackIds.filter((id) => !tracksById.has(id));
    if (missingDeclaredTrackIds.length > 0) {
        const declaredTracks = await db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                _id: { $in: missingDeclaredTrackIds.map(toObjectId) }
            })
            .project(audioTrackProjection)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
        for (const track of declaredTracks) tracksById.set(String(track._id), track);
    }

    const legacyAlbumIds = [...albumsById.values()]
        .filter((album) => !Array.isArray(album?.audioTrackIds) || album.audioTrackIds.length === 0)
        .map((album) => String(album._id));
    if (legacyAlbumIds.length > 0) {
        const legacyObjectIds = legacyAlbumIds.map(toObjectId);
        const legacyTracks = await db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                albumId: { $in: [...legacyAlbumIds, ...legacyObjectIds] }
            })
            .project(audioTrackProjection)
            .sort({ title: 1, _id: 1 })
            .limit(maximumHydratedAlbumTracks)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
        for (const track of legacyTracks) tracksById.set(String(track._id), track);
    }

    const explicitArtistIds = uniqueIds(
        [...tracksById.values()].flatMap((track) =>
            Array.isArray(track?.artistIds) ? track.artistIds : []
        )
    );
    const allAlbumIds = [...albumsById.keys()];
    const artistClauses: Record<string, unknown>[] = [];
    if (explicitArtistIds.length > 0) {
        artistClauses.push({ _id: { $in: explicitArtistIds.map(toObjectId) } });
    }
    if (allAlbumIds.length > 0) {
        artistClauses.push({
            albumIds: { $in: [...allAlbumIds, ...allAlbumIds.map(toObjectId)] }
        });
    }
    const relatedArtists = artistClauses.length > 0
        ? await db.collection('artists')
            .find({ $or: artistClauses })
            .project(artistProjection)
            .sort({ name: 1, _id: 1 })
            .maxTimeMS(queryTimeoutMs)
            .toArray()
        : [];
    const artistsById = documentsById([...relatedArtists, ...seedArtists]);
    const artists = [...artistsById.values()].sort((left, right) =>
        normalizeText(left?.name).localeCompare(normalizeText(right?.name))
        || String(left?._id ?? '').localeCompare(String(right?._id ?? ''))
    );

    const albumTrackIds = new Map<string, string[]>();
    for (const album of albumsById.values()) {
        const albumId = String(album._id);
        const declared = Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : [];
        if (declared.length > 0) {
            albumTrackIds.set(
                albumId,
                uniqueIds(declared.slice(0, maximumAlbumTracks), maximumAlbumTracks)
                    .filter((id) => tracksById.has(id))
            );
            continue;
        }
        albumTrackIds.set(
            albumId,
            [...tracksById.values()]
                .filter((track) => trackBelongsToAlbum(track, albumId))
                .sort(compareTitleAndId)
                .slice(0, maximumAlbumTracks)
                .map((track) => String(track._id))
        );
    }

    return { albumsById, tracksById, artistsById, artists, albumTrackIds };
};

const artistNamesForAlbum = (album: any, context: CatalogContext) => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const trackId of context.albumTrackIds.get(String(album._id)) ?? []) {
        const track = context.tracksById.get(trackId);
        for (const artistId of Array.isArray(track?.artistIds) ? track.artistIds : []) {
            const name = normalizeText(context.artistsById.get(String(artistId))?.name);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
        }
    }
    if (names.length > 0) return names;

    for (const artist of context.artists) {
        if (!artistReferencesAlbum(artist, String(album._id))) continue;
        const name = normalizeText(artist?.name);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
};

const toArtistSummary = (artist: any): ListenerArtistSummary => ({
    contentType: 'artist',
    id: String(artist._id),
    name: normalizeText(artist?.name),
    bio: normalizeText(artist?.bio),
    artworkUrl: resolvedCoverArtUrl(artist)
});

const toAlbumSummary = (album: any, context: CatalogContext): ListenerAlbumSummary => ({
    contentType: 'album',
    id: String(album._id),
    title: normalizeText(album?.title),
    artworkUrl: resolvedCoverArtUrl(album),
    artistNames: artistNamesForAlbum(album, context),
    releaseDate: safeDate(album?.releaseDate)
});

const toAudioTrackSummary = (
    track: any,
    context: CatalogContext
): ListenerAudioTrackSummary => {
    const albumId = isHexObjectId(track?.albumId) ? String(track.albumId) : null;
    const album = albumId ? context.albumsById.get(albumId) : null;
    const artistNames = (Array.isArray(track?.artistIds) ? track.artistIds : [])
        .map((artistId: unknown) => normalizeText(context.artistsById.get(String(artistId))?.name))
        .filter((name: string, index: number, values: string[]) => Boolean(name) && values.indexOf(name) === index);
    return {
        contentType: 'audioTrack',
        id: String(track._id),
        title: normalizeText(track?.title),
        artworkUrl: resolvedCoverArtUrl(track) || resolvedCoverArtUrl(album),
        artistNames,
        albumId,
        albumTitle: album ? normalizeText(album.title) || null : null,
        duration: normalizeText(track?.duration) || null,
        streamUrl: `/content/audioTrack/stream/${encodeURIComponent(String(track._id))}`
    };
};

const resolveCarouselRefs = async (carousel: any, viewerUserId?: string) => {
    const mode = carousel?.mode === 'artist'
        ? 'artist'
        : carousel?.mode === 'personalized' ? 'personalized' : 'manual';
    if (mode === 'manual') return orderedRefs(carousel?.items);

    if (mode === 'personalized') {
        const source = carousel?.personalizedConfig?.source as ActivitySource | undefined;
        const requestedLimit = Number(carousel?.personalizedConfig?.limit ?? 20);
        if (!viewerUserId || (source !== 'recentlySaved' && source !== 'recentlyPlayed')) return [];
        const entries = await UserLibrary.recent(
            viewerUserId,
            source,
            Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 20))
        );
        return entries.flatMap((entry, order): ListenerContentRef[] =>
            isHexObjectId(entry.contentId)
                ? [{ contentType: entry.contentType, contentId: entry.contentId, order }]
                : []
        );
    }

    const config = carousel?.artistConfig;
    const artistId = String(config?.artistId ?? '').trim();
    const contentType = config?.contentType;
    if (!isHexObjectId(artistId) || (contentType !== 'album' && contentType !== 'audioTrack')) return [];
    const limit = Math.max(1, Math.min(Number(config?.limit ?? 20) || 20, 100));
    const db = getDb()!;
    if (contentType === 'album') {
        const artist = await db.collection('artists')
            .find({ _id: toObjectId(artistId) })
            .project({ albumIds: 1 })
            .maxTimeMS(queryTimeoutMs)
            .next();
        const albumIds = uniqueIds(
            Array.isArray(artist?.albumIds) ? artist.albumIds : [],
            maximumAlbumTracks
        );
        if (albumIds.length === 0) return [];
        const sort: Record<string, 1 | -1> = config?.sort === 'titleAsc'
            ? { title: 1, _id: 1 }
            : {
                'releaseDate.year': -1,
                'releaseDate.month': -1,
                'releaseDate.day': -1,
                title: 1,
                _id: 1
            };
        const albums = await db.collection('albums')
            .find({ _id: { $in: albumIds.map(toObjectId) } })
            .project({ _id: 1 })
            .sort(sort)
            .limit(limit)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
        return albums.map((album, order) => ({
            contentType: 'album' as const,
            contentId: String(album._id),
            order
        }));
    }

    const sort: Record<string, 1 | -1> = config?.sort === 'titleAsc'
        ? { title: 1, _id: 1 }
        : {
            'releaseDate.year': -1,
            'releaseDate.month': -1,
            'releaseDate.day': -1,
            title: 1,
            _id: 1
        };
    const tracks = await db.collection('audioTracks')
        .find({
            ...readyAudioFilter,
            artistIds: { $in: [artistId, toObjectId(artistId)] }
        })
        .project({ _id: 1 })
        .sort(sort)
        .limit(limit)
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return tracks.map((track, order) => ({
        contentType: 'audioTrack' as const,
        contentId: String(track._id),
        order
    }));
};

/** Resolves the composed Home page to public, presentation-preserving sections. */
export const getListenerHome = async (viewerUserId?: string) => {
    const db = getDb()!;
    const page: any = await db.collection('pages')
        .find({ slug: 'home' })
        .project({ title: 1, items: 1 })
        .maxTimeMS(queryTimeoutMs)
        .next();
    if (!page) return null;

    const pageItems = Array.isArray(page.items)
        ? [...page.items]
            .sort((left: any, right: any) => Number(left?.order ?? 0) - Number(right?.order ?? 0))
            .slice(0, maximumPageItems)
        : [];
    const carouselIds = uniqueIds(pageItems
        .filter((item: any) => item?.itemType === 'carousel')
        .map((item: any) => item?.carouselId));
    const collectionIds = uniqueIds(pageItems
        .filter((item: any) => item?.itemType === 'grid' || item?.itemType === 'list')
        .map((item: any) => item?.collectionId));
    const [carousels, collections] = await Promise.all([
        carouselIds.length > 0
            ? db.collection('carousels')
                .find({ _id: { $in: carouselIds.map(toObjectId) } })
                .project({ name: 1, mode: 1, items: 1, artistConfig: 1, personalizedConfig: 1 })
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [],
        collectionIds.length > 0
            ? db.collection('contentCollections')
                .find({ _id: { $in: collectionIds.map(toObjectId) } })
                .project({ name: 1, mode: 1, items: 1 })
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : []
    ]);
    const carouselMap = documentsById(carousels);
    const collectionMap = documentsById(collections);

    const sectionDefinitions: Array<{
        id: string;
        title: string;
        presentation: ListenerPresentation;
        refs: ListenerContentRef[];
    }> = [];
    for (const [order, item] of pageItems.entries()) {
        if (item?.itemType === 'carousel') {
            const carousel = carouselMap.get(String(item.carouselId ?? ''));
            if (!carousel) continue;
            sectionDefinitions.push({
                id: `carousel:${carousel._id}:${order}`,
                title: normalizeText(carousel.name),
                presentation: 'carousel',
                refs: await resolveCarouselRefs(carousel, viewerUserId)
            });
            continue;
        }
        if (item?.itemType !== 'grid' && item?.itemType !== 'list') continue;
        const collection = collectionMap.get(String(item.collectionId ?? ''));
        if (!collection) continue;
        sectionDefinitions.push({
            id: `${item.itemType}:${collection._id}:${order}`,
            title: normalizeText(collection.name),
            presentation: item.itemType,
            refs: collection.mode === 'manual' ? orderedRefs(collection.items) : []
        });
    }

    const allRefs = sectionDefinitions.flatMap((section) => section.refs);
    const albumIds = uniqueIds(
        allRefs.filter((ref) => ref.contentType === 'album').map((ref) => ref.contentId)
    );
    const trackIds = uniqueIds(
        allRefs.filter((ref) => ref.contentType === 'audioTrack').map((ref) => ref.contentId)
    );
    const [albums, tracks] = await Promise.all([
        albumIds.length > 0
            ? db.collection('albums')
                .find({ _id: { $in: albumIds.map(toObjectId) } })
                .project(albumProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [],
        trackIds.length > 0
            ? db.collection('audioTracks')
                .find({ ...readyAudioFilter, _id: { $in: trackIds.map(toObjectId) } })
                .project(audioTrackProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : []
    ]);
    const context = await createCatalogContext(albums, tracks);

    const sections: ListenerHomeSection[] = sectionDefinitions.map((section) => ({
        id: section.id,
        title: section.title,
        presentation: section.presentation,
        items: section.refs.flatMap((ref): ListenerPlayableSummary[] => {
            if (ref.contentType === 'album') {
                const album = context.albumsById.get(ref.contentId);
                return album ? [toAlbumSummary(album, context)] : [];
            }
            const track = context.tracksById.get(ref.contentId);
            return track ? [toAudioTrackSummary(track, context)] : [];
        })
    }));

    return { title: normalizeText(page.title) || 'Home', sections };
};

/** Searches each public catalog group while excluding non-ready audio metadata. */
export const searchListenerContent = async (query: string, limit = 20) => {
    const db = getDb()!;
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
    const expression = { $regex: escapeRegex(query), $options: 'i' };
    const [artists, albums, tracks] = await Promise.all([
        db.collection('artists').find({ name: expression })
            .project(artistProjection).sort({ name: 1, _id: 1 })
            .limit(boundedLimit).maxTimeMS(queryTimeoutMs).toArray(),
        db.collection('albums').find({ title: expression })
            .project(albumProjection).sort({ title: 1, _id: 1 })
            .limit(boundedLimit).maxTimeMS(queryTimeoutMs).toArray(),
        db.collection('audioTracks').find({ ...readyAudioFilter, title: expression })
            .project(audioTrackProjection).sort({ title: 1, _id: 1 })
            .limit(boundedLimit).maxTimeMS(queryTimeoutMs).toArray()
    ]);
    const context = await createCatalogContext(albums, tracks, artists);
    return {
        query,
        artists: artists.map(toArtistSummary),
        albums: albums.map((album) => toAlbumSummary(album, context)),
        audioTracks: tracks.map((track) => toAudioTrackSummary(track, context))
    };
};

/** Returns an album and its ready tracks in the canonical declared order. */
export const getListenerAlbum = async (albumId: string) => {
    if (!isHexObjectId(albumId)) return null;
    const db = getDb()!;
    const album: any = await db.collection('albums')
        .find({ _id: toObjectId(albumId) })
        .project(albumProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    if (!album) return null;

    const declared = Array.isArray(album.audioTrackIds) ? album.audioTrackIds : [];
    let tracks: any[];
    if (declared.length > 0) {
        const ids = uniqueIds(declared.slice(0, maximumAlbumTracks), maximumAlbumTracks);
        const found = ids.length > 0
            ? await db.collection('audioTracks')
                .find({ ...readyAudioFilter, _id: { $in: ids.map(toObjectId) } })
                .project(audioTrackProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [];
        const byId = documentsById(found);
        tracks = ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
    } else {
        tracks = await db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                albumId: { $in: [albumId, toObjectId(albumId)] }
            })
            .project(audioTrackProjection)
            .sort({ title: 1, _id: 1 })
            .limit(maximumAlbumTracks)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
    }
    const context = await createCatalogContext([album], tracks);
    return {
        album: toAlbumSummary(album, context),
        tracks: tracks.map((track) => toAudioTrackSummary(track, context))
    };
};

/** Returns one public artist with linked albums and ready soundtracks. */
export const getListenerArtist = async (artistId: string) => {
    if (!isHexObjectId(artistId)) return null;
    const db = getDb()!;
    const artist: any = await db.collection('artists')
        .find({ _id: toObjectId(artistId) })
        .project(artistProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    if (!artist) return null;

    const albumIds = uniqueIds(
        (Array.isArray(artist.albumIds) ? artist.albumIds : []).slice(0, maximumAlbumTracks),
        maximumAlbumTracks
    );
    const [unorderedAlbums, tracks] = await Promise.all([
        albumIds.length > 0
            ? db.collection('albums')
                .find({ _id: { $in: albumIds.map(toObjectId) } })
                .project(albumProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [],
        db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                artistIds: { $in: [artistId, toObjectId(artistId)] }
            })
            .project(audioTrackProjection)
            .sort({ title: 1, _id: 1 })
            .limit(maximumAlbumTracks)
            .maxTimeMS(queryTimeoutMs)
            .toArray()
    ]);
    const albumsById = documentsById(unorderedAlbums);
    const albums = albumIds.flatMap((id) => albumsById.has(id) ? [albumsById.get(id)] : []);
    const context = await createCatalogContext(albums, tracks, [artist]);
    return {
        artist: toArtistSummary(artist),
        albums: albums.map((album) => toAlbumSummary(album, context)),
        audioTracks: tracks.map((track) => toAudioTrackSummary(track, context))
    };
};

/** Returns metadata only when the corresponding audio lifecycle is playable. */
export const getListenerAudioTrack = async (audioTrackId: string) => {
    if (!isHexObjectId(audioTrackId)) return null;
    const track: any = await getDb()!.collection('audioTracks')
        .find({ ...readyAudioFilter, _id: toObjectId(audioTrackId) })
        .project(audioTrackProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    if (!track) return null;
    const context = await createCatalogContext([], [track]);
    return { audioTrack: toAudioTrackSummary(track, context) };
};

/** Strips lifecycle and ownership fields from the existing paginated Library result. */
export const sanitizeListenerLibraryPage = (page: any) => ({
    items: (Array.isArray(page?.items) ? page.items : []).flatMap((item: any) => {
        const common = {
            contentType: item?.contentType,
            contentId: String(item?.contentId ?? ''),
            savedAt: item?.savedAt,
            lastPlayedAt: item?.lastPlayedAt ?? null,
            lastActivityAt: item?.lastActivityAt ?? item?.savedAt,
            creator: normalizeText(item?.creator) || null
        };
        if (item?.contentType === 'album' && item.album?._id) {
            return [{
                ...common,
                contentType: 'album' as const,
                album: {
                    _id: String(item.album._id),
                    title: normalizeText(item.album.title),
                    coverArtUrl: resolvedCoverArtUrl(item.album),
                    releaseDate: safeDate(item.album.releaseDate)
                }
            }];
        }
        if (item?.contentType === 'audioTrack' && item.audioTrack?._id) {
            const available = item.audioTrack.uploadStatus === 'ready'
                && Boolean(String(item.audioTrack.s3Key ?? '').trim());
            const audioTrackId = String(item.audioTrack._id);
            return [{
                ...common,
                contentType: 'audioTrack' as const,
                audioTrack: {
                    _id: audioTrackId,
                    title: normalizeText(item.audioTrack.title),
                    displayCoverArtUrl: String(item.audioTrack.displayCoverArtUrl ?? '').trim(),
                    coverArtUrl: resolvedCoverArtUrl(item.audioTrack),
                    albumId: isHexObjectId(item.audioTrack.albumId)
                        ? String(item.audioTrack.albumId)
                        : null,
                    duration: normalizeText(item.audioTrack.duration) || null,
                    available,
                    streamUrl: available
                        ? `/content/audioTrack/stream/${encodeURIComponent(audioTrackId)}`
                        : null
                }
            }];
        }
        return [];
    }),
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null
});

/** Preserves Library pagination semantics while returning only listener-safe fields. */
export const listListenerLibrary = async (userId: string, options: LibraryListOptions) =>
    sanitizeListenerLibraryPage(await UserLibrary.list(userId, options));
