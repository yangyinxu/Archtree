import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { resolvedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import { normalizeUtf8Text } from '../utils/textEncoding';
import {
    isAudioObjectKeyForTrack,
    readyAudioStorageFilter
} from '../utils/audioStorageKey';
import {
    isReadyArtistLifecycle,
    readyArtistLifecycleFilter
} from './artistReferenceFenceService';
import {
    isReadyAlbumLifecycle,
    readyAlbumLifecycleFilter
} from './albumReferenceFenceService';
import {
    AttributionStatus,
    CatalogCreditRole,
    normalizeCatalogCredits,
    validateAttribution
} from '../models/catalogCredit';
import { readyOrganizationLifecycleFilter } from './organizationReferenceFenceService';
import { catalogCreditRollout } from '../config/catalogCreditRollout';

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

export interface PublicOrganization {
    _id: string;
    name: string;
    organizationType: string;
    description: string;
}

export interface PublicAlbum {
    _id: string;
    title: string;
    coverArtUrl: string;
    audioTrackIds: string[];
    releaseDate: PublicSimpleDate | null;
    credits?: PublicCatalogCredit[];
    displayByline?: string;
    attributionStatus?: AttributionStatus;
}

export interface PublicCatalogCredit {
    subjectType: 'artist' | 'organization';
    subjectId: string;
    name: string;
    role: CatalogCreditRole;
    order: number;
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
    credits?: PublicCatalogCredit[];
    displayByline?: string;
    attributionStatus?: AttributionStatus;
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

export const readyPublicAudioFilter = readyAudioStorageFilter;

const artistProjection = {
    _id: 1,
    name: 1,
    albumIds: 1,
    bio: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    birthDate: 1
};
const organizationProjection = {
    _id: 1,
    name: 1,
    organizationType: 1,
    description: 1
};
const albumProjection = {
    _id: 1,
    title: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    audioTrackIds: 1,
    releaseDate: 1,
    lifecycleStatus: 1,
    credits: 1,
    attributionStatus: 1
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
    s3Key: 1,
    credits: 1,
    attributionStatus: 1
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
    return objectIdPattern.test(id) ? id.toLowerCase() : null;
};
const toObjectId = (value: string) => ObjectId.createFromHexString(value);
const storedObjectIdValues = (value: string) => [
    value,
    value.toUpperCase(),
    toObjectId(value)
];
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

const validCredits = (owner: any) => {
    if (!catalogCreditRollout().readsEnabled) return null;
    if (!Array.isArray(owner?.credits)) return null;
    try {
        const credits = normalizeCatalogCredits(owner.credits);
        validateAttribution(owner.attributionStatus, credits);
        return credits;
    } catch {
        return null;
    }
};

const loadCreditSubjectNames = async (owners: any[]) => {
    const credits = owners.flatMap((owner) => validCredits(owner) ?? []);
    const artistIds = uniqueObjectIdStrings(credits
        .filter((credit) => credit.subjectType === 'artist').map((credit) => credit.subjectId));
    const organizationIds = uniqueObjectIdStrings(credits
        .filter((credit) => credit.subjectType === 'organization').map((credit) => credit.subjectId));
    const [artists, organizations] = await Promise.all([
        artistIds.length > 0 ? getDb()!.collection('artists').find({
            _id: { $in: artistIds.map(toObjectId) },
            ...readyArtistLifecycleFilter
        }).project({ name: 1 }).toArray() : [],
        organizationIds.length > 0 ? getDb()!.collection('organizations').find({
            _id: { $in: organizationIds.map(toObjectId) },
            ...readyOrganizationLifecycleFilter
        }).project({ name: 1 }).toArray() : []
    ]);
    return new Map<string, string>([
        ...artists.map((subject) => [`artist:${String(subject._id)}`, normalizedText(subject.name)] as const),
        ...organizations.map((subject) => [`organization:${String(subject._id)}`, normalizedText(subject.name)] as const)
    ]);
};

const publicCreditFields = (owner: any, subjectNames?: ReadonlyMap<string, string>) => {
    const credits = validCredits(owner);
    if (!credits) return {};
    const projected = credits.flatMap((credit): PublicCatalogCredit[] => {
        const name = subjectNames?.get(`${credit.subjectType}:${credit.subjectId}`);
        return name ? [{ ...credit, name }] : [];
    });
    const preferred = projected.filter((credit) => ['primary', 'featured', 'performer']
        .includes(credit.role));
    const institutional = projected.filter((credit) => credit.subjectType === 'organization');
    const byline = preferred.length > 0 ? preferred : institutional.length > 0 ? institutional : projected;
    return {
        credits: projected,
        displayByline: owner.attributionStatus === 'unknown'
            ? 'Attribution not documented'
            : [...new Set(byline.map((credit) => credit.name))].join(', '),
        attributionStatus: owner.attributionStatus as AttributionStatus
    };
};

/** Resolves durable role-aware bylines for private Library projections without exposing subjects. */
export const resolvePublicCatalogBylines = async (owners: any[]) => {
    const subjectNames = await loadCreditSubjectNames(owners);
    return new Map(owners.flatMap((owner): Array<[string, string]> => {
        const id = String(owner?._id ?? '');
        const byline = publicCreditFields(owner, subjectNames).displayByline;
        return id && byline ? [[id, byline]] : [];
    }));
};

/** Returns true only when MongoDB records a playable object lifecycle. */
export const isReadyPublicAudioTrack = (track: any) =>
    track?.uploadStatus === 'ready'
    && (!Object.prototype.hasOwnProperty.call(track ?? {}, 'publicationStatus')
        || track?.publicationStatus === 'ready')
    && isAudioObjectKeyForTrack(track?.s3Key, String(track?._id ?? ''));

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
    readyAudioTrackIds: readonly string[] = [],
    subjectNames?: ReadonlyMap<string, string>
): PublicAlbum => ({
    _id: String(album?._id ?? ''),
    title: normalizedText(album?.title),
    coverArtUrl: resolvedCoverArtUrl(album),
    audioTrackIds: uniqueObjectIdStrings([...readyAudioTrackIds], maximumAlbumTracks),
    releaseDate: publicDate(album?.releaseDate),
    ...publicCreditFields(album, subjectNames)
});

/** Projects one ready Soundtrack to the legacy Web/iOS-compatible public DTO. */
export const toPublicAudioTrack = (
    track: any,
    album?: any,
    visibleArtistIds?: ReadonlySet<string>,
    subjectNames?: ReadonlyMap<string, string>
): PublicAudioTrack | null => {
    if (!isReadyPublicAudioTrack(track)) return null;
    const visibleAlbumId = album ? objectIdString(track?.albumId) : null;
    return {
        _id: String(track?._id ?? ''),
        title: normalizedText(track?.title),
        coverArtUrl: resolvedCoverArtUrl(track),
        displayCoverArtUrl: resolvedCoverArtUrl(track) || resolvedCoverArtUrl(album),
        albumId: visibleAlbumId,
        artistIds: uniqueObjectIdStrings(Array.isArray(track?.artistIds) ? track.artistIds : [])
            .filter((id) => visibleArtistIds === undefined || visibleArtistIds.has(id)),
        genres: (Array.isArray(track?.genres) ? track.genres : [])
            .map(normalizedText)
            .filter(Boolean),
        releaseDate: publicDate(track?.releaseDate),
        duration: normalizedText(track?.duration) || null,
        format: publicFormat(track?.format),
        ...publicCreditFields(track, subjectNames)
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
        .find({
            _id: { $in: albumIds.map(toObjectId) },
            ...readyAlbumLifecycleFilter
        })
        .project({ _id: 1 })
        .maxTimeMS(queryTimeoutMs)
        .toArray();
    return new Set(albums.map((album) => String(album._id)));
};

/** Adds database-confirmed Album references to public Artist DTOs. */
export const projectPublicArtists = async (artists: any[]) => {
    const readyArtists = artists.filter(isReadyArtistLifecycle);
    const visibleAlbumIds = await loadVisibleAlbumIds(readyArtists);
    return readyArtists.map((artist) => toPublicArtist(artist, visibleAlbumIds));
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
        albumId: { $in: storedObjectIdValues(albumId) }
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
        .filter((album) => album?.lifecycleStatus === undefined
            && (!Array.isArray(album?.audioTrackIds) || album.audioTrackIds.length === 0))
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
    const readyIds = new Set(declaredTracks.flatMap((track) => {
        const id = objectIdString(track?._id);
        return id ? [id] : [];
    }));

    return new Map(albums.map((album) => {
        const albumId = objectIdString(album?._id) ?? '';
        const declared = uniqueObjectIdStrings(
            Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : [],
            maximumAlbumTracks
        ).filter((id) => readyIds.has(id));
        if (Array.isArray(album?.audioTrackIds) && album.audioTrackIds.length > 0) {
            return [albumId, declared] as const;
        }
        if (album?.lifecycleStatus !== undefined) {
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
    const readyAlbums = albums.filter(isReadyAlbumLifecycle);
    const [trackIdsByAlbum, subjectNames] = await Promise.all([
        loadReadyAlbumTrackIds(readyAlbums, dependencies),
        loadCreditSubjectNames(readyAlbums)
    ]);
    return readyAlbums.map((album) => toPublicAlbum(
        album,
        trackIdsByAlbum.get(objectIdString(album?._id) ?? '') ?? [],
        subjectNames
    ));
};

/** Filters and projects Soundtracks, deriving Album artwork without exposing IDs for assets. */
export const projectPublicAudioTracks = async (tracks: any[]) => {
    const readyTracks = tracks.filter(isReadyPublicAudioTrack);
    const albumIds = uniqueObjectIdStrings(readyTracks.map((track) => track?.albumId));
    const artistIds = uniqueObjectIdStrings(readyTracks.flatMap((track) =>
        Array.isArray(track?.artistIds) ? track.artistIds : []
    ));
    const [albums, artists, subjectNames] = await Promise.all([
        albumIds.length > 0
            ? getDb()!.collection('albums')
            .find({
                _id: { $in: albumIds.map(toObjectId) },
                ...readyAlbumLifecycleFilter
            })
            .project({ _id: 1, coverArtId: 1, coverArtUrl: 1 })
            .maxTimeMS(queryTimeoutMs)
            .toArray()
            : [],
        artistIds.length > 0
            ? getDb()!.collection('artists')
                .find({
                    _id: { $in: artistIds.map(toObjectId) },
                    ...readyArtistLifecycleFilter
                })
                .project({ _id: 1 })
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [],
        loadCreditSubjectNames(readyTracks)
    ]);
    const albumsById = new Map(albums.map((album) => [
        objectIdString(album._id) ?? '',
        album
    ] as const));
    const visibleArtistIds = new Set(artists.flatMap((artist) => {
        const id = objectIdString(artist._id);
        return id ? [id] : [];
    }));
    return readyTracks.flatMap((track): PublicAudioTrack[] => {
        const projected = toPublicAudioTrack(
            track,
            albumsById.get(objectIdString(track?.albumId) ?? ''),
            visibleArtistIds,
            subjectNames
        );
        return projected ? [projected] : [];
    });
};

export const listPublicArtists = async (limit: number, offset: number) => {
    const artists = await getDb()!.collection('artists')
        .find(readyArtistLifecycleFilter)
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
        .find({ _id: toObjectId(id), ...readyArtistLifecycleFilter })
        .project(artistProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    return artist ? (await projectPublicArtists([artist]))[0] : null;
};

export const listPublicAlbums = async (limit: number, offset: number) => {
    const albums = await getDb()!.collection('albums')
        .find(readyAlbumLifecycleFilter)
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
        .find({ _id: toObjectId(id), ...readyAlbumLifecycleFilter })
        .project(albumProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    return album ? (await projectPublicAlbums([album]))[0] : null;
};

/** Returns one ready Organization and only ready releases that credit it. */
export const getPublicOrganization = async (organizationId: string) => {
    if (!catalogCreditRollout().organizationSurfacesEnabled) return null;
    const id = objectIdString(organizationId);
    if (!id) return null;
    const organization = await getDb()!.collection('organizations').find({
        _id: toObjectId(id),
        ...readyOrganizationLifecycleFilter
    }).project(organizationProjection).maxTimeMS(queryTimeoutMs).next();
    if (!organization) return null;
    const albums = await getDb()!.collection('albums').find({
        ...readyAlbumLifecycleFilter,
        credits: { $elemMatch: { subjectType: 'organization', subjectId: id } }
    }).project(albumProjection).sort({
        'releaseDate.year': -1,
        'releaseDate.month': -1,
        'releaseDate.day': -1,
        title: 1,
        _id: 1
    }).limit(maximumAlbumTracks).maxTimeMS(queryTimeoutMs).toArray();
    return {
        organization: {
            _id: String(organization._id),
            name: normalizedText(organization.name),
            organizationType: normalizedText(organization.organizationType),
            description: normalizedText(organization.description)
        } satisfies PublicOrganization,
        releases: await projectPublicAlbums(albums)
    };
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
    const organizationSearch = catalogCreditRollout().organizationSurfacesEnabled
        ? getDb()!.collection('organizations').find({
            name: expression,
            ...readyOrganizationLifecycleFilter
        }).project(organizationProjection).sort({ name: 1, _id: 1 })
            .limit(limit).maxTimeMS(queryTimeoutMs).toArray()
        : Promise.resolve([]);
    const [artists, organizations, albums, tracks] = await Promise.all([
        getDb()!.collection('artists').find({
            name: expression,
            ...readyArtistLifecycleFilter
        })
            .project(artistProjection).sort({ name: 1, _id: 1 })
            .limit(limit).maxTimeMS(queryTimeoutMs).toArray(),
        organizationSearch,
        getDb()!.collection('albums').find({
            title: expression,
            ...readyAlbumLifecycleFilter
        })
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
        organizations: organizations.map((organization): PublicOrganization => ({
            _id: String(organization._id),
            name: normalizedText(organization.name),
            organizationType: normalizedText(organization.organizationType),
            description: normalizedText(organization.description)
        })),
        albums: publicAlbums,
        audioTracks: publicTracks
    };
};
