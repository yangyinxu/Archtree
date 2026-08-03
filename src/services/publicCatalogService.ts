import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { resolvedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import { normalizeUtf8Text } from '../utils/textEncoding';

export interface PublicSimpleDate {
    year?: number;
    month?: number;
    day?: number;
}

export interface PublicArtist {
    _id: string;
    name: string;
    albumIds: string[];
    bio: string;
    coverArtUrl: string;
    birthDate: PublicSimpleDate | null;
}

export interface PublicAlbum {
    _id: string;
    title: string;
    coverArtUrl: string;
    audioTrackIds: string[];
    releaseDate: PublicSimpleDate | null;
}

export interface PublicAudioTrack {
    _id: string;
    title: string;
    coverArtUrl: string;
    displayCoverArtUrl: string;
    albumId: string | null;
    artistIds: string[];
    genres: string[];
    releaseDate: PublicSimpleDate | null;
    duration: string | null;
    format: { type: string; bitrate?: number } | null;
}

export interface PublicFeedPost {
    _id: string;
    title: string;
    description: string;
    mainImageUrl: string;
    imageUrls: string[];
    userId: string;
    createdAt: string;
}

export const readyPublicAudioFilter = {
    uploadStatus: 'ready',
    s3Key: { $type: 'string', $regex: /\S/ }
};

const artistProjection = {
    _id: 1,
    name: 1,
    albumIds: 1,
    bio: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    birthDate: 1
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
    albumId: 1,
    artistIds: 1,
    genres: 1,
    releaseDate: 1,
    duration: 1,
    format: 1,
    uploadStatus: 1,
    s3Key: 1
};

const queryTimeoutMs = 3_000;
const maximumRelatedIds = 10_000;
const maximumAlbumTracks = 500;
const fallbackAlbumLookupConcurrency = 10;
const objectIdPattern = /^[0-9a-fA-F]{24}$/;

export interface PublicAlbumProjectionDependencies {
    findReadyDeclaredTracks?: (trackIds: readonly string[]) => Promise<any[]>;
    findReadyFallbackTracksForAlbum?: (
        albumId: string,
        limit: number
    ) => Promise<any[]>;
}

const normalizedText = (value: unknown) => normalizeUtf8Text(String(value ?? '').trim());
const objectIdString = (value: unknown) => {
    const id = String(value ?? '').trim();
    return objectIdPattern.test(id) ? id : null;
};
const toObjectId = (value: string) => ObjectId.createFromHexString(value);
const uniqueObjectIdStrings = (values: unknown[], limit = maximumRelatedIds) => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const id = objectIdString(value);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
    }
    return ids;
};

const publicDate = (value: unknown): PublicSimpleDate | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const date: PublicSimpleDate = {};
    const year = Number(source.year);
    const month = Number(source.month);
    const day = Number(source.day);
    if (Number.isInteger(year) && year >= 1 && year <= 9_999) date.year = year;
    if (Number.isInteger(month) && month >= 1 && month <= 12) date.month = month;
    if (Number.isInteger(day) && day >= 1 && day <= 31) date.day = day;
    return Object.keys(date).length > 0 ? date : null;
};

const publicFormat = (value: unknown): PublicAudioTrack['format'] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const type = normalizedText(source.type);
    if (!type) return null;
    const bitrate = Number(source.bitrate);
    return Number.isFinite(bitrate) && bitrate >= 0 ? { type, bitrate } : { type };
};

/** Returns true only when MongoDB records a playable object lifecycle. */
export const isReadyPublicAudioTrack = (track: any) =>
    track?.uploadStatus === 'ready' && Boolean(String(track?.s3Key ?? '').trim());

/** Projects one Artist without provenance, storage, or unrelated database fields. */
export const toPublicArtist = (
    artist: any,
    visibleAlbumIds: ReadonlySet<string> = new Set()
): PublicArtist => ({
    _id: String(artist?._id ?? ''),
    name: normalizedText(artist?.name),
    albumIds: uniqueObjectIdStrings(Array.isArray(artist?.albumIds) ? artist.albumIds : [])
        .filter((id) => visibleAlbumIds.has(id)),
    bio: normalizedText(artist?.bio),
    coverArtUrl: resolvedCoverArtUrl(artist),
    birthDate: publicDate(artist?.birthDate)
});

/** Projects one Album while omitting references to unavailable Soundtracks. */
export const toPublicAlbum = (
    album: any,
    readyAudioTrackIds: readonly string[] = []
): PublicAlbum => ({
    _id: String(album?._id ?? ''),
    title: normalizedText(album?.title),
    coverArtUrl: resolvedCoverArtUrl(album),
    audioTrackIds: uniqueObjectIdStrings([...readyAudioTrackIds], maximumAlbumTracks),
    releaseDate: publicDate(album?.releaseDate)
});

/** Projects one ready Soundtrack to the legacy Web/iOS-compatible public DTO. */
export const toPublicAudioTrack = (
    track: any,
    album?: any
): PublicAudioTrack | null => {
    if (!isReadyPublicAudioTrack(track)) return null;
    return {
        _id: String(track?._id ?? ''),
        title: normalizedText(track?.title),
        coverArtUrl: resolvedCoverArtUrl(track),
        displayCoverArtUrl: resolvedCoverArtUrl(track) || resolvedCoverArtUrl(album),
        albumId: objectIdString(track?.albumId),
        artistIds: uniqueObjectIdStrings(Array.isArray(track?.artistIds) ? track.artistIds : []),
        genres: (Array.isArray(track?.genres) ? track.genres : [])
            .map(normalizedText)
            .filter(Boolean),
        releaseDate: publicDate(track?.releaseDate),
        duration: normalizedText(track?.duration) || null,
        format: publicFormat(track?.format)
    };
};

/** Projects a Feed Post while retaining the author ID required by existing clients. */
export const toPublicFeedPost = (post: any): PublicFeedPost => {
    const createdAt = post?.createdAt instanceof Date
        ? post.createdAt.toISOString()
        : String(post?.createdAt ?? '');
    return {
        _id: String(post?._id ?? ''),
        title: normalizedText(post?.title),
        description: normalizedText(post?.description),
        mainImageUrl: String(post?.mainImageUrl ?? '').trim(),
        imageUrls: (Array.isArray(post?.imageUrls) ? post.imageUrls : [])
            .map((value: unknown) => String(value ?? '').trim())
            .filter(Boolean),
        userId: String(post?.userId ?? ''),
        createdAt
    };
};

const loadVisibleAlbumIds = async (artists: any[]) => {
    const albumIds = uniqueObjectIdStrings(artists.flatMap((artist) =>
        Array.isArray(artist?.albumIds) ? artist.albumIds : []
    ));
    if (albumIds.length === 0) return new Set<string>();
    const albums = await getDb()!.collection('albums')
        .find({ _id: { $in: albumIds.map(toObjectId) } })
        .project({ _id: 1 })
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return new Set(albums.map((album) => String(album._id)));
};

/** Adds database-confirmed Album references to public Artist DTOs. */
export const projectPublicArtists = async (artists: any[]) => {
    const visibleAlbumIds = await loadVisibleAlbumIds(artists);
    return artists.map((artist) => toPublicArtist(artist, visibleAlbumIds));
};

const findReadyDeclaredTracks = (trackIds: readonly string[]) => getDb()!
    .collection('audioTracks')
    .find({
        ...readyPublicAudioFilter,
        _id: { $in: trackIds.map(toObjectId) }
    })
    .project({ _id: 1 })
    .maxTimeMS(queryTimeoutMs)
    .toArray();

const findReadyFallbackTracksForAlbum = (albumId: string, limit: number) => getDb()!
    .collection('audioTracks')
    .find({
        ...readyPublicAudioFilter,
        albumId: { $in: [albumId, toObjectId(albumId)] }
    })
    .project({ _id: 1, albumId: 1, title: 1 })
    .sort({ title: 1, _id: 1 })
    .limit(limit)
    .maxTimeMS(queryTimeoutMs)
    .toArray();

/** Gives every legacy Album its own bounded reverse-reference query. */
const loadFallbackTrackIdsByAlbum = async (
    albumIds: string[],
    loader: NonNullable<PublicAlbumProjectionDependencies['findReadyFallbackTracksForAlbum']>
) => {
    const inferredByAlbum = new Map<string, string[]>();
    for (let index = 0; index < albumIds.length; index += fallbackAlbumLookupConcurrency) {
        const batch = albumIds.slice(index, index + fallbackAlbumLookupConcurrency);
        const results = await Promise.all(batch.map(async (albumId) => {
            const tracks = await loader(albumId, maximumAlbumTracks);
            const trackIds = uniqueObjectIdStrings(
                tracks
                    .filter((track) => objectIdString(track?.albumId) === albumId)
                    .map((track) => track?._id),
                maximumAlbumTracks
            );
            return [albumId, trackIds] as const;
        }));
        for (const [albumId, trackIds] of results) inferredByAlbum.set(albumId, trackIds);
    }
    return inferredByAlbum;
};

const loadReadyAlbumTrackIds = async (
    albums: any[],
    dependencies: PublicAlbumProjectionDependencies = {}
) => {
    const fallbackAlbumIds = uniqueObjectIdStrings(albums
        .filter((album) => !Array.isArray(album?.audioTrackIds) || album.audioTrackIds.length === 0)
        .map((album) => album?._id), Math.max(1, albums.length));
    const declaredTrackIds = uniqueObjectIdStrings(
        albums.flatMap((album) =>
            Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : []
        ),
        maximumAlbumTracks * Math.max(1, albums.length)
    );
    const declaredLoader = dependencies.findReadyDeclaredTracks ?? findReadyDeclaredTracks;
    const fallbackLoader = dependencies.findReadyFallbackTracksForAlbum
        ?? findReadyFallbackTracksForAlbum;
    const [declaredTracks, inferredByAlbum] = await Promise.all([
        declaredTrackIds.length > 0
            ? declaredLoader(declaredTrackIds)
            : [],
        fallbackAlbumIds.length > 0
            ? loadFallbackTrackIdsByAlbum(fallbackAlbumIds, fallbackLoader)
            : new Map<string, string[]>()
    ]);
    const readyIds = new Set(declaredTracks.map((track) => String(track._id)));

    return new Map(albums.map((album) => {
        const albumId = String(album?._id ?? '');
        const declared = uniqueObjectIdStrings(
            Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : [],
            maximumAlbumTracks
        ).filter((id) => readyIds.has(id));
        if (Array.isArray(album?.audioTrackIds) && album.audioTrackIds.length > 0) {
            return [albumId, declared] as const;
        }
        const seen = new Set(declared);
        const inferred = (inferredByAlbum.get(albumId) ?? [])
            .filter((id) => !seen.has(id))
            .slice(0, Math.max(0, maximumAlbumTracks - declared.length));
        return [albumId, [...declared, ...inferred]] as const;
    }));
};

/** Adds only ready, database-confirmed Soundtrack references to public Albums. */
export const projectPublicAlbums = async (
    albums: any[],
    dependencies: PublicAlbumProjectionDependencies = {}
) => {
    const trackIdsByAlbum = await loadReadyAlbumTrackIds(albums, dependencies);
    return albums.map((album) => toPublicAlbum(
        album,
        trackIdsByAlbum.get(String(album?._id ?? '')) ?? []
    ));
};

/** Filters and projects Soundtracks, deriving Album artwork without exposing IDs for assets. */
export const projectPublicAudioTracks = async (tracks: any[]) => {
    const readyTracks = tracks.filter(isReadyPublicAudioTrack);
    const albumIds = uniqueObjectIdStrings(readyTracks.map((track) => track?.albumId));
    const albums = albumIds.length > 0
        ? await getDb()!.collection('albums')
            .find({ _id: { $in: albumIds.map(toObjectId) } })
            .project({ _id: 1, coverArtId: 1, coverArtUrl: 1 })
            .maxTimeMS(queryTimeoutMs)
            .toArray()
        : [];
    const albumsById = new Map(albums.map((album) => [String(album._id), album] as const));
    return readyTracks.flatMap((track): PublicAudioTrack[] => {
        const projected = toPublicAudioTrack(
            track,
            albumsById.get(String(track?.albumId ?? ''))
        );
        return projected ? [projected] : [];
    });
};

export const listPublicArtists = async (limit: number, offset: number) => {
    const artists = await getDb()!.collection('artists')
        .find()
        .project(artistProjection)
        .sort({ name: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return projectPublicArtists(artists);
};

export const getPublicArtist = async (artistId: string) => {
    const id = objectIdString(artistId);
    if (!id) return null;
    const artist = await getDb()!.collection('artists')
        .find({ _id: toObjectId(id) })
        .project(artistProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    return artist ? (await projectPublicArtists([artist]))[0] : null;
};

export const listPublicAlbums = async (limit: number, offset: number) => {
    const albums = await getDb()!.collection('albums')
        .find()
        .project(albumProjection)
        .sort({ title: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return projectPublicAlbums(albums);
};

export const getPublicAlbum = async (albumId: string) => {
    const id = objectIdString(albumId);
    if (!id) return null;
    const album = await getDb()!.collection('albums')
        .find({ _id: toObjectId(id) })
        .project(albumProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    return album ? (await projectPublicAlbums([album]))[0] : null;
};

export const listPublicAudioTracks = async (limit: number, offset: number) => {
    const tracks = await getDb()!.collection('audioTracks')
        .find(readyPublicAudioFilter)
        .project(audioTrackProjection)
        .sort({ title: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return projectPublicAudioTracks(tracks);
};

export const searchPublicCatalog = async (query: string, limit: number) => {
    const expression = { $regex: escapeRegex(query), $options: 'i' };
    const [artists, albums, tracks] = await Promise.all([
        getDb()!.collection('artists').find({ name: expression })
            .project(artistProjection).sort({ name: 1, _id: 1 })
            .limit(limit).maxTimeMS(queryTimeoutMs).toArray(),
        getDb()!.collection('albums').find({ title: expression })
            .project(albumProjection).sort({ title: 1, _id: 1 })
            .limit(limit).maxTimeMS(queryTimeoutMs).toArray(),
        getDb()!.collection('audioTracks').find({ ...readyPublicAudioFilter, title: expression })
            .project(audioTrackProjection).sort({ title: 1, _id: 1 })
            .limit(limit).maxTimeMS(queryTimeoutMs).toArray()
    ]);
    const [publicArtists, publicAlbums, publicTracks] = await Promise.all([
        projectPublicArtists(artists),
        projectPublicAlbums(albums),
        projectPublicAudioTracks(tracks)
    ]);
    return {
        query,
        artists: publicArtists,
        albums: publicAlbums,
        audioTracks: publicTracks
    };
};
