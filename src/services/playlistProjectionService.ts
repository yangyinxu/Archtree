import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import {
    MAX_PLAYLIST_ITEMS,
    MAX_PLAYLIST_PAGE_SIZE,
    PlaylistDocument,
    PlaylistItemDocument,
    PlaylistListResult,
    PlaylistPageV1,
    PlaylistSummaryV1,
    normalizePlaylistObjectId,
    toPlaylistSummary
} from '../models/playlist';
import type { ListenerAudioTrackSummary } from './listenerContentService';
import { resolvedCoverArtUrl } from '../utils/coverArt';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { readyArtistLifecycleFilter } from './artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from './albumReferenceFenceService';

export interface PlaylistItemV1 {
    itemId: string;
    audioTrackId: string;
    addedAt: string;
    availability: 'ready' | 'unavailable';
    audioTrack: ListenerAudioTrackSummary | null;
}

export interface PlaylistDetailV1 extends PlaylistSummaryV1 {
    items: PlaylistItemV1[];
}

const queryTimeoutMs = 3_000;
const readyAudioFilter = readyAudioStorageFilter;
const audioTrackProjection = {
    _id: 1,
    title: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    artistIds: 1,
    albumId: 1,
    duration: 1
};
const albumProjection = {
    _id: 1,
    title: 1,
    coverArtId: 1,
    coverArtUrl: 1
};
const artistProjection = { _id: 1, name: 1 };
const artworkTrackProjection = {
    _id: 1,
    coverArtId: 1,
    coverArtUrl: 1,
    albumId: 1
};
const artworkAlbumProjection = {
    _id: 1,
    coverArtId: 1,
    coverArtUrl: 1
};
const maximumArtworkCandidates = MAX_PLAYLIST_PAGE_SIZE * MAX_PLAYLIST_ITEMS;
const maximumArtworkUrlLength = 2_048;
const artworkControlCharacters = /[\u0000-\u001F\u007F]/;

const normalizedText = (value: unknown) => normalizeUtf8Text(String(value ?? '').trim());
const safeIsoDate = (value: unknown) => {
    const date = value instanceof Date ? value : new Date(String(value ?? ''));
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};
const documentsById = (documents: any[]) => new Map(
    documents.map((document) => [String(document._id), document] as const)
);
const uniqueObjectIds = (values: unknown[], limit = maximumArtworkCandidates) => {
    const ids = new Set<string>();
    for (const value of values) {
        const id = normalizePlaylistObjectId(value);
        if (id) ids.add(id);
        if (ids.size >= limit) break;
    }
    return [...ids];
};

const isAllowedArtworkUrl = (artworkUrl: string) => {
    if (artworkUrl.startsWith('/')) {
        return !artworkUrl.startsWith('//') && !artworkUrl.includes('\\');
    }
    try {
        const parsed = new URL(artworkUrl);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
};

/** Selects the first bounded safe artwork reference, otherwise signaling client fallback. */
const safeArtworkUrl = (...records: Array<Record<string, any> | null | undefined>) => {
    for (const record of records) {
        const artworkUrl = resolvedCoverArtUrl(record).trim();
        if (artworkUrl
            && artworkUrl.length <= maximumArtworkUrlLength
            && !artworkControlCharacters.test(artworkUrl)
            && isAllowedArtworkUrl(artworkUrl)) {
            return artworkUrl;
        }
    }
    return '';
};

export interface PlaylistArtworkProjectionDependencies {
    findReadyTracks?: (audioTrackIds: string[]) => Promise<any[]>;
    findAlbums?: (albumIds: string[]) => Promise<any[]>;
}

const findReadyArtworkTracks = (audioTrackIds: string[]) => getDb()!
    .collection('audioTracks')
    .find({
        ...readyAudioFilter,
        _id: { $in: audioTrackIds.map((id) => ObjectId.createFromHexString(id)) }
    })
    .project(artworkTrackProjection)
    .maxTimeMS(queryTimeoutMs)
    .toArray();

const findArtworkAlbums = (albumIds: string[]) => getDb()!
    .collection('albums')
    .find({
        _id: { $in: albumIds.map((id) => ObjectId.createFromHexString(id)) },
        ...readyAlbumLifecycleFilter
    })
    .project(artworkAlbumProjection)
    .maxTimeMS(queryTimeoutMs)
    .toArray();

/** Derives every summary cover through two page-wide catalog reads, never per Playlist. */
export const toPlaylistPage = async (
    page: PlaylistListResult,
    dependencies: PlaylistArtworkProjectionDependencies = {}
): Promise<PlaylistPageV1> => {
    const records = page.records.slice(0, MAX_PLAYLIST_PAGE_SIZE);
    const audioTrackIdsByPlaylist = records.map((record) => uniqueObjectIds(
        (Array.isArray(record.artworkAudioTrackIds) ? record.artworkAudioTrackIds : [])
            .slice(0, MAX_PLAYLIST_ITEMS),
        MAX_PLAYLIST_ITEMS
    ));
    const audioTrackIds = uniqueObjectIds(
        audioTrackIdsByPlaylist.flat(),
        maximumArtworkCandidates
    );
    const tracks = audioTrackIds.length > 0
        ? await (dependencies.findReadyTracks ?? findReadyArtworkTracks)(audioTrackIds)
        : [];
    const tracksById = documentsById(tracks);
    const albumIds = uniqueObjectIds(tracks.flatMap((track) => {
        if (safeArtworkUrl(track)) return [];
        return [track.albumId];
    }));
    const albums = albumIds.length > 0
        ? await (dependencies.findAlbums ?? findArtworkAlbums)(albumIds)
        : [];
    const albumsById = documentsById(albums);

    return {
        items: records.map((record, index) => {
            const artworkUrl = audioTrackIdsByPlaylist[index]
                .map((audioTrackId) => {
                    const track = tracksById.get(audioTrackId);
                    const albumId = normalizePlaylistObjectId(track?.albumId);
                    return safeArtworkUrl(track, albumId ? albumsById.get(albumId) : null);
                })
                .find(Boolean) ?? '';
            return toPlaylistSummary(record, artworkUrl);
        }),
        nextCursor: page.nextCursor
    };
};

const normalizedItem = (item: PlaylistItemDocument): PlaylistItemDocument => ({
    itemId: String(item?.itemId ?? ''),
    audioTrackId: normalizePlaylistObjectId(item?.audioTrackId)
        ?? String(item?.audioTrackId ?? ''),
    addedAt: item?.addedAt instanceof Date ? item.addedAt : new Date(String(item?.addedAt ?? ''))
});

/** Hydrates all ready members in three bounded queries and restores persisted order. */
export const toPlaylistDetail = async (playlist: PlaylistDocument): Promise<PlaylistDetailV1> => {
    const items = (Array.isArray(playlist.items) ? playlist.items : [])
        .slice(0, MAX_PLAYLIST_ITEMS)
        .map(normalizedItem);
    const audioTrackIds = uniqueObjectIds(items.map((item) => item.audioTrackId));
    const db = getDb()!;
    const tracks = audioTrackIds.length > 0
        ? await db.collection('audioTracks')
            .find({
                ...readyAudioFilter,
                _id: { $in: audioTrackIds.map((id) => ObjectId.createFromHexString(id)) }
            })
            .project(audioTrackProjection)
            .maxTimeMS(queryTimeoutMs)
            .toArray()
        : [];
    const albumIds = uniqueObjectIds(tracks.map((track) => track.albumId));
    const artistIds = uniqueObjectIds(tracks.flatMap((track) =>
        Array.isArray(track.artistIds) ? track.artistIds : []
    ));
    const [albums, artists] = await Promise.all([
        albumIds.length > 0
            ? db.collection('albums')
                .find({
                    _id: { $in: albumIds.map((id) => ObjectId.createFromHexString(id)) },
                    ...readyAlbumLifecycleFilter
                })
                .project(albumProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : [],
        artistIds.length > 0
            ? db.collection('artists')
                .find({
                    _id: { $in: artistIds.map((id) => ObjectId.createFromHexString(id)) },
                    ...readyArtistLifecycleFilter
                })
                .project(artistProjection)
                .maxTimeMS(queryTimeoutMs)
                .toArray()
            : []
    ]);
    const tracksById = documentsById(tracks);
    const albumsById = documentsById(albums);
    const artistsById = documentsById(artists);

    const projectedItems = items.map((item) => {
        const track = tracksById.get(item.audioTrackId);
        if (!track) {
            return {
                itemId: item.itemId,
                audioTrackId: item.audioTrackId,
                addedAt: safeIsoDate(item.addedAt),
                availability: 'unavailable' as const,
                audioTrack: null
            };
        }
        const albumId = normalizePlaylistObjectId(track.albumId);
        const album = albumId ? albumsById.get(albumId) : null;
        const artistNames = (Array.isArray(track.artistIds) ? track.artistIds : [])
            .map((artistId: unknown) => normalizedText(
                artistsById.get(String(artistId))?.name
            ))
            .filter((name: string, index: number, values: string[]) =>
                Boolean(name) && values.indexOf(name) === index
            );
        return {
            itemId: item.itemId,
            audioTrackId: item.audioTrackId,
            addedAt: safeIsoDate(item.addedAt),
            availability: 'ready' as const,
            audioTrack: {
                contentType: 'audioTrack' as const,
                id: item.audioTrackId,
                title: normalizedText(track.title),
                artworkUrl: safeArtworkUrl(track, album),
                artistNames,
                albumId,
                albumTitle: album ? normalizedText(album.title) || null : null,
                duration: normalizedText(track.duration) || null,
                streamUrl: `/content/audioTrack/stream/${encodeURIComponent(item.audioTrackId)}`
            }
        };
    });
    const artworkUrl = projectedItems.find((item) => item.audioTrack?.artworkUrl)
        ?.audioTrack?.artworkUrl ?? '';

    return {
        ...toPlaylistSummary(playlist, artworkUrl),
        items: projectedItems
    };
};

/** Returns a detached ready-only queue projection without changing persisted membership. */
export const readyPlaylistQueue = (detail: PlaylistDetailV1) => detail.items.flatMap((item) =>
    item.availability === 'ready' && item.audioTrack ? [item.audioTrack] : []
);
