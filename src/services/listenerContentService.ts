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
    CatalogCredit,
    CatalogCreditRole,
    classifyArtistAlbumCredit,
    normalizeCatalogCredits,
    validateAttribution
} from '../models/catalogCredit';
import { readyOrganizationLifecycleFilter } from './organizationReferenceFenceService';
import { Carousel } from '../models/carousel';
import { catalogCreditRollout } from '../config/catalogCreditRollout';

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

export interface ListenerOrganizationSummary {
    contentType: 'organization';
    id: string;
    name: string;
    organizationType: string;
    description: string;
}

export interface ListenerAlbumSummary {
    contentType: 'album';
    id: string;
    title: string;
    artworkUrl: string;
    artistNames: string[];
    releaseDate: ListenerDate | null;
    credits?: ListenerCatalogCredit[];
    displayByline?: string;
    attributionStatus?: AttributionStatus;
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
    credits?: ListenerCatalogCredit[];
    displayByline?: string;
    attributionStatus?: AttributionStatus;
}

export interface ListenerCatalogCredit {
    subjectType: 'artist' | 'organization';
    subjectId: string;
    name: string;
    role: CatalogCreditRole;
    order: number;
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
    organizationsById: Map<string, any>;
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
    artistIds: 1,
    albumId: 1,
    duration: 1,
    releaseDate: 1,
    credits: 1,
    attributionStatus: 1
};
const readyAudioFilter = readyAudioStorageFilter;

const isHexObjectId = (value: unknown): value is string =>
    /^[0-9a-fA-F]{24}$/.test(String(value ?? '').trim());

const toObjectId = (value: string) => ObjectId.createFromHexString(value);
const storedObjectIdValues = (value: string) => [
    value,
    value.toUpperCase(),
    toObjectId(value)
];

const uniqueIds = (values: unknown[], limit = maximumHydratedAlbumTracks) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const id = String(value ?? '').trim().toLowerCase();
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
            const contentId = String(item?.contentId ?? '').trim().toLowerCase();
            if ((contentType !== 'album' && contentType !== 'audioTrack') || !isHexObjectId(contentId)) {
                return [];
            }
            return [{ contentType, contentId, order: index }];
        });
};

const documentsById = (documents: any[]) => new Map(
    documents
        .filter((document) => document?._id)
        .map((document) => [String(document._id).toLowerCase(), document] as const)
);

const trackBelongsToAlbum = (track: any, albumId: string) =>
    String(track?.albumId ?? '').trim().toLowerCase() === albumId.toLowerCase();

const artistReferencesAlbum = (artist: any, albumId: string) =>
    (Array.isArray(artist?.albumIds) ? artist.albumIds : [])
        .some((id: unknown) => String(id).trim().toLowerCase() === albumId.toLowerCase());

const compareTitleAndId = (left: any, right: any) =>
    normalizeText(left?.title).localeCompare(normalizeText(right?.title))
    || String(left?._id ?? '').localeCompare(String(right?._id ?? ''));

const validStoredCredits = (owner: any): CatalogCredit[] | null => {
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

/** Loads only the catalog fields needed to create public listener DTOs. */
const createCatalogContext = async (
    seedAlbums: any[] = [],
    seedTracks: any[] = [],
    seedArtists: any[] = []
): Promise<CatalogContext> => {
    const db = getDb()!;
    const albumsById = documentsById(seedAlbums.filter(isReadyAlbumLifecycle));
    const tracksById = documentsById(seedTracks);

    const linkedAlbumIds = uniqueIds(
        seedTracks.map((track) => track?.albumId),
        maximumHydratedAlbumTracks
    ).filter((id) => !albumsById.has(id));
    if (linkedAlbumIds.length > 0) {
        const linkedAlbums = await db.collection('albums')
            .find({
                _id: { $in: linkedAlbumIds.map(toObjectId) },
                ...readyAlbumLifecycleFilter
            })
            .project(albumProjection)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
        for (const album of linkedAlbums) albumsById.set(String(album._id).toLowerCase(), album);
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
        for (const track of declaredTracks) tracksById.set(String(track._id).toLowerCase(), track);
    }

    const legacyAlbumIds = [...albumsById.values()]
        .filter((album) => album?.lifecycleStatus === undefined
            && (!Array.isArray(album?.audioTrackIds) || album.audioTrackIds.length === 0))
        .map((album) => String(album._id).toLowerCase());
    if (legacyAlbumIds.length > 0) {
        for (let index = 0; index < legacyAlbumIds.length; index += 10) {
            const batch = legacyAlbumIds.slice(index, index + 10);
            const legacyTrackBatches = await Promise.all(batch.map((albumId) =>
                db.collection('audioTracks')
                    .find({
                        ...readyAudioFilter,
                        albumId: { $in: storedObjectIdValues(albumId) }
                    })
                    .project(audioTrackProjection)
                    .sort({ title: 1, _id: 1 })
                    .limit(maximumAlbumTracks)
                    .maxTimeMS(queryTimeoutMs)
                    .toArray()
            ));
            for (const track of legacyTrackBatches.flat()) {
                tracksById.set(String(track._id).toLowerCase(), track);
            }
        }
    }

    const explicitArtistIds = uniqueIds(
        [
            ...[...tracksById.values()].flatMap((track) =>
                Array.isArray(track?.artistIds) ? track.artistIds : []
            ),
            ...[...albumsById.values(), ...tracksById.values()].flatMap((owner) =>
                (validStoredCredits(owner) ?? [])
                    .filter((credit) => credit.subjectType === 'artist')
                    .map((credit) => credit.subjectId)
            )
        ]
    );
    const allAlbumIds = [...albumsById.keys()];
    const artistClauses: Record<string, unknown>[] = [];
    if (explicitArtistIds.length > 0) {
        artistClauses.push({ _id: { $in: explicitArtistIds.map(toObjectId) } });
    }
    if (allAlbumIds.length > 0) {
        artistClauses.push({
            albumIds: { $in: allAlbumIds.flatMap(storedObjectIdValues) }
        });
    }
    const relatedArtists = artistClauses.length > 0
        ? await db.collection('artists')
            .find({ $and: [readyArtistLifecycleFilter, { $or: artistClauses }] })
            .project(artistProjection)
            .sort({ name: 1, _id: 1 })
            .maxTimeMS(queryTimeoutMs)
            .toArray()
        : [];
    const artistsById = documentsById(
        [...relatedArtists, ...seedArtists].filter(isReadyArtistLifecycle)
    );
    const artists = [...artistsById.values()].sort((left, right) =>
        normalizeText(left?.name).localeCompare(normalizeText(right?.name))
        || String(left?._id ?? '').localeCompare(String(right?._id ?? ''))
    );

    const organizationIds = uniqueIds(
        [...albumsById.values(), ...tracksById.values()].flatMap((owner) =>
            (validStoredCredits(owner) ?? [])
                .filter((credit) => credit.subjectType === 'organization')
                .map((credit) => credit.subjectId)
        )
    );
    const organizations = organizationIds.length > 0
        ? await db.collection('organizations').find({
            _id: { $in: organizationIds.map(toObjectId) },
            ...readyOrganizationLifecycleFilter
        }).project({ _id: 1, name: 1, organizationType: 1 })
            .maxTimeMS(queryTimeoutMs).toArray()
        : [];
    const organizationsById = documentsById(organizations);

    const albumTrackIds = new Map<string, string[]>();
    for (const album of albumsById.values()) {
        const albumId = String(album._id).toLowerCase();
        const declared = Array.isArray(album?.audioTrackIds) ? album.audioTrackIds : [];
        if (declared.length > 0) {
            albumTrackIds.set(
                albumId,
                uniqueIds(declared.slice(0, maximumAlbumTracks), maximumAlbumTracks)
                    .filter((id) => tracksById.has(id))
            );
            continue;
        }
        if (album.lifecycleStatus !== undefined) {
            albumTrackIds.set(albumId, []);
            continue;
        }
        albumTrackIds.set(
            albumId,
            [...tracksById.values()]
                .filter((track) => trackBelongsToAlbum(track, albumId))
                .sort(compareTitleAndId)
                .slice(0, maximumAlbumTracks)
                .map((track) => String(track._id).toLowerCase())
        );
    }

    return { albumsById, tracksById, artistsById, artists, organizationsById, albumTrackIds };
};

const creditProjectionForOwner = (owner: any, context: CatalogContext) => {
    const credits = validStoredCredits(owner);
    if (!credits) return {};
    const publicCredits = credits.flatMap((credit): ListenerCatalogCredit[] => {
        const subject = credit.subjectType === 'artist'
            ? context.artistsById.get(credit.subjectId)
            : context.organizationsById.get(credit.subjectId);
        const name = normalizeText(subject?.name);
        return name ? [{
            subjectType: credit.subjectType,
            subjectId: credit.subjectId,
            name,
            role: credit.role,
            order: credit.order
        }] : [];
    });
    const preferredRoles = new Set(['primary', 'featured', 'performer']);
    const preferred = publicCredits.filter((credit) => preferredRoles.has(credit.role));
    const institutional = publicCredits.filter((credit) => credit.subjectType === 'organization');
    const bylineCredits = preferred.length > 0
        ? preferred
        : institutional.length > 0 ? institutional : publicCredits;
    const displayByline = owner.attributionStatus === 'unknown'
        ? 'Attribution not documented'
        : [...new Set(bylineCredits.map((credit) => credit.name))].join(', ');
    return {
        credits: publicCredits,
        displayByline,
        attributionStatus: owner.attributionStatus as AttributionStatus
    };
};

const artistNamesForAlbum = (album: any, context: CatalogContext) => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const trackId of context.albumTrackIds.get(String(album._id).toLowerCase()) ?? []) {
        const track = context.tracksById.get(trackId);
        for (const artistId of Array.isArray(track?.artistIds) ? track.artistIds : []) {
            const name = normalizeText(context.artistsById.get(String(artistId).toLowerCase())?.name);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
        }
    }
    if (names.length > 0) return names;

    for (const artist of context.artists) {
        if (!artistReferencesAlbum(artist, String(album._id).toLowerCase())) continue;
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
    artistNames: (() => {
        const creditNames = (validStoredCredits(album) ?? [])
            .filter((credit) => credit.subjectType === 'artist'
                && (credit.role === 'primary' || credit.role === 'featured'))
            .map((credit) => normalizeText(context.artistsById.get(credit.subjectId)?.name))
            .filter(Boolean);
        return creditNames.length > 0 ? [...new Set(creditNames)] : artistNamesForAlbum(album, context);
    })(),
    releaseDate: safeDate(album?.releaseDate),
    ...creditProjectionForOwner(album, context)
});

const toAudioTrackSummary = (
    track: any,
    context: CatalogContext
): ListenerAudioTrackSummary => {
    const referencedAlbumId = isHexObjectId(track?.albumId)
        ? String(track.albumId).toLowerCase()
        : null;
    const album = referencedAlbumId ? context.albumsById.get(referencedAlbumId) : null;
    const albumId = album ? referencedAlbumId : null;
    const creditArtistNames = (validStoredCredits(track) ?? [])
        .filter((credit) => credit.subjectType === 'artist')
        .map((credit) => normalizeText(context.artistsById.get(credit.subjectId)?.name))
        .filter(Boolean);
    const artistNames = (creditArtistNames.length > 0
        ? creditArtistNames
        : (Array.isArray(track?.artistIds) ? track.artistIds : [])
        .map((artistId: unknown) => normalizeText(
            context.artistsById.get(String(artistId).toLowerCase())?.name
        ))
    ).filter((name: string, index: number, values: string[]) => Boolean(name) && values.indexOf(name) === index);
    return {
        contentType: 'audioTrack',
        id: String(track._id),
        title: normalizeText(track?.title),
        artworkUrl: resolvedCoverArtUrl(track) || resolvedCoverArtUrl(album),
        artistNames,
        albumId,
        albumTitle: album ? normalizeText(album.title) || null : null,
        duration: normalizeText(track?.duration) || null,
        streamUrl: `/content/audioTrack/stream/${encodeURIComponent(String(track._id))}`,
        ...creditProjectionForOwner(track, context)
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
        const limit = Math.max(
            1,
            Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 20)
        );
        const entries = await UserLibrary.recent(viewerUserId, source, 20);
        const albumIds = uniqueIds(entries
            .filter((entry) => entry.contentType === 'album')
            .map((entry) => entry.contentId));
        const trackIds = uniqueIds(entries
            .filter((entry) => entry.contentType === 'audioTrack')
            .map((entry) => entry.contentId));
        const db = getDb()!;
        const [albums, tracks] = await Promise.all([
            albumIds.length > 0
                ? db.collection('albums').find({
                    _id: { $in: albumIds.map(toObjectId) },
                    ...readyAlbumLifecycleFilter
                })
                    .project({ _id: 1 }).maxTimeMS(queryTimeoutMs).toArray()
                : [],
            trackIds.length > 0
                ? db.collection('audioTracks').find({
                    ...readyAudioFilter,
                    _id: { $in: trackIds.map(toObjectId) }
                }).project({ _id: 1 }).maxTimeMS(queryTimeoutMs).toArray()
                : []
        ]);
        const validKeys = new Set([
            ...albums.map((item) => `album:${item._id}`),
            ...tracks.map((item) => `audioTrack:${item._id}`)
        ]);
        return entries
            .filter((entry) => validKeys.has(
                `${entry.contentType}:${String(entry.contentId).toLowerCase()}`
            ))
            .slice(0, limit)
            .map((entry, order) => ({
                contentType: entry.contentType,
                contentId: String(entry.contentId).toLowerCase(),
                order
            }));
    }

    const resolved = await Carousel.resolveCarousel(carousel, viewerUserId);
    return orderedRefs(resolved?.items);
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
            const carousel = carouselMap.get(String(item.carouselId ?? '').toLowerCase());
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
        const collection = collectionMap.get(String(item.collectionId ?? '').toLowerCase());
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
                .find({
                    _id: { $in: albumIds.map(toObjectId) },
                    ...readyAlbumLifecycleFilter
                })
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
    const organizationSearch = catalogCreditRollout().organizationSurfacesEnabled
        ? db.collection('organizations').find({
            name: expression,
            ...readyOrganizationLifecycleFilter
        }).project(organizationProjection).sort({ name: 1, _id: 1 })
            .limit(boundedLimit).maxTimeMS(queryTimeoutMs).toArray()
        : Promise.resolve([]);
    const [artists, organizations, albums, tracks] = await Promise.all([
        db.collection('artists').find({ name: expression, ...readyArtistLifecycleFilter })
            .project(artistProjection).sort({ name: 1, _id: 1 })
            .limit(boundedLimit).maxTimeMS(queryTimeoutMs).toArray(),
        organizationSearch,
        db.collection('albums').find({
            title: expression,
            ...readyAlbumLifecycleFilter
        })
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
        organizations: organizations.map((organization): ListenerOrganizationSummary => ({
            contentType: 'organization',
            id: String(organization._id),
            name: normalizeText(organization.name),
            organizationType: normalizeText(organization.organizationType),
            description: normalizeText(organization.description)
        })),
        albums: albums.map((album) => toAlbumSummary(album, context)),
        audioTracks: tracks.map((track) => toAudioTrackSummary(track, context))
    };
};

/** Returns an album and its ready tracks in the canonical declared order. */
export const getListenerAlbum = async (albumId: string) => {
    if (!isHexObjectId(albumId)) return null;
    const normalizedAlbumId = albumId.trim().toLowerCase();
    const db = getDb()!;
    const album: any = await db.collection('albums')
        .find({ _id: toObjectId(normalizedAlbumId), ...readyAlbumLifecycleFilter })
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
    } else if (album.lifecycleStatus === undefined) {
        tracks = await db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                albumId: { $in: storedObjectIdValues(normalizedAlbumId) }
            })
            .project(audioTrackProjection)
            .sort({ title: 1, _id: 1 })
            .limit(maximumAlbumTracks)
            .maxTimeMS(queryTimeoutMs)
            .toArray();
    } else {
        tracks = [];
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
    const normalizedArtistId = artistId.trim().toLowerCase();
    const db = getDb()!;
    const artist: any = await db.collection('artists')
        .find({ _id: toObjectId(normalizedArtistId), ...readyArtistLifecycleFilter })
        .project(artistProjection)
        .maxTimeMS(queryTimeoutMs)
        .next();
    if (!artist) return null;

    const legacyAlbumIds = uniqueIds(
        (Array.isArray(artist.albumIds) ? artist.albumIds : []).slice(0, maximumAlbumTracks),
        maximumAlbumTracks
    );
    const [creditAlbums, tracks] = await Promise.all([
        db.collection('albums').find({
            ...readyAlbumLifecycleFilter,
            credits: {
                $elemMatch: {
                    subjectType: 'artist',
                    subjectId: normalizedArtistId
                }
            }
        }).project(albumProjection).sort({ title: 1, _id: 1 })
            .limit(maximumAlbumTracks).maxTimeMS(queryTimeoutMs).toArray(),
        db.collection('audioTracks')
            .find({
                $and: [
                    readyAudioFilter,
                    { $or: [
                        { artistIds: { $in: storedObjectIdValues(normalizedArtistId) } },
                        {
                            credits: {
                                $elemMatch: {
                                    subjectType: 'artist',
                                    subjectId: normalizedArtistId
                                }
                            }
                        }
                    ] }
                ]
            })
            .project(audioTrackProjection)
            .sort({ title: 1, _id: 1 })
            .limit(maximumAlbumTracks)
            .maxTimeMS(queryTimeoutMs)
            .toArray()
    ]);
    const relatedAlbumIds = uniqueIds([
        ...legacyAlbumIds,
        ...creditAlbums.map((album) => album._id),
        ...tracks.map((track) => track.albumId)
    ], maximumAlbumTracks);
    const loadedAlbums = relatedAlbumIds.length > 0
        ? await db.collection('albums').find({
            _id: { $in: relatedAlbumIds.map(toObjectId) },
            ...readyAlbumLifecycleFilter
        }).project(albumProjection).maxTimeMS(queryTimeoutMs).toArray()
        : [];
    const albumsById = documentsById([...creditAlbums, ...loadedAlbums]);
    const orderedAlbumIds = [
        ...legacyAlbumIds,
        ...[...albumsById.keys()].filter((id) => !legacyAlbumIds.includes(id))
    ];
    const albums = orderedAlbumIds.flatMap((id) => albumsById.has(id) ? [albumsById.get(id)] : []);
    const context = await createCatalogContext(albums, tracks, [artist]);
    const sectionsEnabled = catalogCreditRollout().readsEnabled
        && catalogCreditRollout().sectionsEnabled;
    const sections = {
        discography: [] as ListenerAlbumSummary[],
        collaborations: [] as ListenerAlbumSummary[],
        appearsOn: [] as ListenerAlbumSummary[],
        creditAlbums: [] as ListenerAlbumSummary[]
    };
    for (const album of albums) {
        const albumId = String(album._id).toLowerCase();
        const albumCredits = sectionsEnabled ? validStoredCredits(album) ?? [] : [];
        const relatedTrackCredits = tracks
            .filter((track) => trackBelongsToAlbum(track, albumId))
            .flatMap((track) => validStoredCredits(track) ?? []);
        let section = sectionsEnabled ? classifyArtistAlbumCredit(
            normalizedArtistId,
            albumCredits,
            relatedTrackCredits
        ) : null;
        if (!section && legacyAlbumIds.includes(albumId)) section = 'discography';
        if (!section && tracks.some((track) => trackBelongsToAlbum(track, albumId)
            && (Array.isArray(track.artistIds) ? track.artistIds : [])
                .some((id: unknown) => String(id).toLowerCase() === normalizedArtistId))) {
            section = 'appearsOn';
        }
        const summary = toAlbumSummary(album, context);
        if (section === 'discography') sections.discography.push(summary);
        else if (section === 'collaborations') sections.collaborations.push(summary);
        else if (section === 'appearsOn') sections.appearsOn.push(summary);
        else if (section === 'credits') sections.creditAlbums.push(summary);
    }
    return {
        artist: toArtistSummary(artist),
        albums: sections.discography,
        audioTracks: tracks.map((track) => toAudioTrackSummary(track, context)),
        ...sections
    };
};

/** Returns one ready Organization and Albums carrying its institutional Credits. */
export const getListenerOrganization = async (organizationId: string) => {
    if (!catalogCreditRollout().organizationSurfacesEnabled) return null;
    if (!isHexObjectId(organizationId)) return null;
    const normalizedOrganizationId = organizationId.trim().toLowerCase();
    const db = getDb()!;
    const organization: any = await db.collection('organizations').find({
        _id: toObjectId(normalizedOrganizationId),
        ...readyOrganizationLifecycleFilter
    }).project(organizationProjection)
        .maxTimeMS(queryTimeoutMs).next();
    if (!organization) return null;
    const albums = await db.collection('albums').find({
        ...readyAlbumLifecycleFilter,
        credits: { $elemMatch: {
            subjectType: 'organization',
            subjectId: normalizedOrganizationId
        } }
    }).project(albumProjection).sort({
        'releaseDate.year': -1,
        'releaseDate.month': -1,
        'releaseDate.day': -1,
        title: 1,
        _id: 1
    }).limit(maximumAlbumTracks).maxTimeMS(queryTimeoutMs).toArray();
    const context = await createCatalogContext(albums, [], []);
    return {
        organization: {
            id: String(organization._id),
            name: normalizeText(organization.name),
            organizationType: normalizeText(organization.organizationType),
            description: normalizeText(organization.description)
        },
        releases: albums.map((album) => toAlbumSummary(album, context))
    };
};

/** Returns metadata only when the corresponding audio lifecycle is playable. */
export const getListenerAudioTrack = async (audioTrackId: string) => {
    if (!isHexObjectId(audioTrackId)) return null;
    const normalizedAudioTrackId = audioTrackId.trim().toLowerCase();
    const track: any = await getDb()!.collection('audioTracks')
        .find({ ...readyAudioFilter, _id: toObjectId(normalizedAudioTrackId) })
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
            contentId: String(item?.contentId ?? '').toLowerCase(),
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
                    // The native Library contract requires this field. Album
                    // detail resolves the canonical ready order separately.
                    audioTrackIds: [],
                    releaseDate: safeDate(item.album.releaseDate)
                }
            }];
        }
        if (item?.contentType === 'audioTrack' && item.audioTrack?._id) {
            const audioTrackId = String(item.audioTrack._id);
            const hasPublicationStatus = Object.prototype.hasOwnProperty.call(
                item.audioTrack,
                'publicationStatus'
            );
            const available = item.audioTrack.uploadStatus === 'ready'
                && (!hasPublicationStatus || item.audioTrack.publicationStatus === 'ready')
                && isAudioObjectKeyForTrack(item.audioTrack.s3Key, audioTrackId);
            return [{
                ...common,
                contentType: 'audioTrack' as const,
                audioTrack: {
                    _id: audioTrackId,
                    title: normalizeText(item.audioTrack.title),
                    displayCoverArtUrl: String(item.audioTrack.displayCoverArtUrl ?? '').trim(),
                    coverArtUrl: resolvedCoverArtUrl(item.audioTrack),
                    albumId: isHexObjectId(item.audioTrack.albumId)
                        ? String(item.audioTrack.albumId).toLowerCase()
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
