import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../../infrastructure/database';
import { readyAudioStorageFilter } from '../../utils/audioStorageKey';
import { activeMediaTypeForTrack, type MediaType } from '../../utils/mediaStorageKey';
import { embeddedDiscNumber } from '../../services/audio/audioMetadataService';
import { AdminCatalogError, adminCatalogEditableFields, readAdminCatalogRecord, withCurrentAdministrator } from './adminCatalogService';

/** The listener Album read bound, so both surfaces read the same leading part of an oversized legacy membership. */
export const ADMIN_ALBUM_TRACKS_LIMIT = 500;
/** Why a member is not playable; `ready` members are the ones listeners receive when they and the Album are public. */
export type AdminAlbumTrackState = 'ready' | 'pending' | 'failed' | 'deleting' | 'unpublished' | 'unavailable';
export type AdminAlbumTrack = {
    position: number; id: string; title: string; discNumber: number | null; trackNumber: number | null;
    duration: string | null; mediaType: MediaType; visibility: 'public' | 'hidden'; state: AdminAlbumTrackState;
    /** Its own Album link is absent or names another Album, which blocks a catalog review of this Album. */
    linkedElsewhere: boolean;
};
/** A declared member ID without any MediaTrack record. */
export type AdminAlbumMissingTrack = { position: number; id: string; state: 'missing' };
export type AdminAlbumTracks = {
    albumId: string; order: 'declared' | 'legacyAlbumLinks'; truncated: boolean;
    /** Malformed or repeated declared entries within the read bound, which listeners skip and a review refuses. */
    skipped: number;
    tracks: Array<AdminAlbumTrack | AdminAlbumMissingTrack>;
};

const objectIdText = /^[0-9a-f]{24}$/;
// Server-side inputs only: storage and legacy video fields decide the media kind, the Album link decides `linkedElsewhere`,
// and none of them is returned.
const memberProjection = { _id: 1, albumId: 1, title: 1, discNumber: 1, trackNumber: 1, duration: 1, mediaType: 1, contentType: 1, s3Key: 1,
    videoAsset: 1, visibility: 1, uploadStatus: 1, publicationStatus: 1 };

/** Normalizes like the listener read: trimmed lowercase IDs, first occurrence kept; malformed and repeated entries are counted. */
const declaredMemberIds = (declared: unknown[]) => {
    const ids: string[] = [], seen = new Set<string>();
    let skipped = 0;
    for (const value of declared.slice(0, ADMIN_ALBUM_TRACKS_LIMIT)) {
        const id = String(value ?? '').trim().toLowerCase();
        if (objectIdText.test(id) && !seen.has(id)) { seen.add(id); ids.push(id); } else skipped += 1;
    }
    return { ids, skipped };
};
/** Duration is display text written at upload; anything other than a clock value reads as unknown. */
const displayDuration = (value: unknown) => {
    const duration = typeof value === 'string' ? value.trim() : '';
    return /^\d{1,3}(:[0-5]\d){1,2}$/.test(duration) ? duration : null;
};
/** Names the first unmet readiness condition of a member outside the ready storage filter. */
const unreadyState = (track: any): AdminAlbumTrackState => {
    if (track.uploadStatus === 'deleting' || track.uploadStatus === 'deleteFailed') return 'deleting';
    if (track.uploadStatus === 'failed') return 'failed';
    if (track.uploadStatus !== 'ready') return 'pending';
    if (track.publicationStatus !== undefined && track.publicationStatus !== 'ready') return 'unpublished';
    // Uploaded and published, but the stored object key does not belong to this MediaTrack and kind.
    return 'unavailable';
};
const member = (track: any, position: number, ready: boolean, albumId: string): AdminAlbumTrack => {
    const fields = adminCatalogEditableFields('audioTrack', track);
    return { position, id: String(track._id), title: fields.title as string, discNumber: embeddedDiscNumber(track.discNumber) ?? null,
        trackNumber: fields.trackNumber as number | null, duration: displayDuration(track.duration), mediaType: activeMediaTypeForTrack(track),
        visibility: track.visibility === undefined || track.visibility === 'public' ? 'public' : 'hidden', state: ready ? 'ready' : unreadyState(track),
        linkedElsewhere: String(track.albumId ?? '').toLowerCase() !== albumId };
};

/** Reads members of every lifecycle state, then the canonical ready filter decides which of them are ready. */
const readMembers = async (ids: string[], session: ClientSession) => {
    if (!ids.length) return { found: new Map<string, any>(), ready: new Set<string>() };
    const tracks = getDb()!.collection('audioTracks'), filter = { _id: { $in: ids.map(id => new ObjectId(id)) } };
    const found = await tracks.find(filter, { session, projection: memberProjection, maxTimeMS: 3_000 }).limit(ADMIN_ALBUM_TRACKS_LIMIT).toArray();
    const ready = await tracks.find({ ...filter, ...readyAudioStorageFilter }, { session, projection: { _id: 1 }, maxTimeMS: 3_000 }).limit(ADMIN_ALBUM_TRACKS_LIMIT).toArray();
    return { found: new Map(found.map(track => [String(track._id), track])), ready: new Set(ready.map(track => String(track._id))) };
};

/**
 * The read-only member list of the administrator Album page, in the order listeners receive: the declared
 * `Album.audioTrackIds`, or for a legacy Album without declared IDs its ready linked MediaTracks by title. Hidden, non-ready,
 * deleting, Video and missing members are listed with their state, and skipped entries are counted; it writes no catalog
 * record and changes no revision.
 */
export const getAdminCatalogAlbumTracks = (actor: string, albumId: string): Promise<AdminAlbumTracks> => withCurrentAdministrator(actor, async session => {
    const album = await readAdminCatalogRecord('album', albumId, session);
    if (!album) throw new AdminCatalogError(404, 'ADMIN_CATALOG_NOT_FOUND');
    const id = String(album._id), declared: unknown[] = Array.isArray(album.audioTrackIds) ? album.audioTrackIds : [];
    if (!declared.length && album.lifecycleStatus === undefined) {
        const linked = await getDb()!.collection('audioTracks').find({ albumId: { $in: [id, id.toUpperCase(), album._id] }, ...readyAudioStorageFilter },
            { session, projection: memberProjection, maxTimeMS: 3_000 }).sort({ title: 1, _id: 1 }).limit(ADMIN_ALBUM_TRACKS_LIMIT + 1).toArray();
        return { albumId: id, order: 'legacyAlbumLinks', truncated: linked.length > ADMIN_ALBUM_TRACKS_LIMIT, skipped: 0,
            tracks: linked.slice(0, ADMIN_ALBUM_TRACKS_LIMIT).map((track, index) => member(track, index + 1, true, id)) };
    }
    const { ids, skipped } = declaredMemberIds(declared), { found, ready } = await readMembers(ids, session);
    return { albumId: id, order: 'declared', truncated: declared.length > ADMIN_ALBUM_TRACKS_LIMIT, skipped,
        tracks: ids.map((trackId, index) => found.has(trackId) ? member(found.get(trackId), index + 1, ready.has(trackId), id)
            : { position: index + 1, id: trackId, state: 'missing' as const }) };
});
