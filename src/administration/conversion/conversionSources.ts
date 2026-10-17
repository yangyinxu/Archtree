import { createHash } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../../infrastructure/database';
import { readyAudioStorageFilter } from '../../utils/audioStorageKey';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import { adminCatalogEditableFields, adminCatalogItemRevision, readAdminCatalogRecord, withCurrentAdministrator } from '../catalog/adminCatalogService';
import { CONVERSION_MAX_FILES, conversionDigest, conversionFail, conversionId, type ConversionIntent, type ConversionSourceManifest } from './conversionContract';

/** Storage evidence needs a separate fence because ordinary metadata revisions intentionally omit bytes. */
export function conversionTrackSourceRevision(track: any): string {
    return `mr_${createHash('sha256').update(JSON.stringify({ id: String(track._id), key: activeMediaObjectKeyForTrack(track),
        kind: activeMediaTypeForTrack(track), contentType: track.contentType ?? null, filename: track.originalFileName ?? null,
        representation: track.mediaRepresentation ?? null })).digest('hex').slice(0, 32)}`;
}
export function conversionAlbumMembershipRevision(ids: readonly string[]) { return `cm_${conversionDigest(ids)}`; }
const requireId = (id: string) => { if (!conversionId(id)) conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT'); };
const members = (album: any): string[] => {
    const ids = album.audioTrackIds;
    if (!Array.isArray(ids) || ids.length > CONVERSION_MAX_FILES || ids.some(id => !conversionId(id)) || new Set(ids).size !== ids.length) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_UNAVAILABLE');
    return ids;
};
const audio = (track: any) => track && activeMediaTypeForTrack(track) === 'audio' && activeMediaObjectKeyForTrack(track);
const basename = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\\/:\u0000-\u001f\u007f-\u009f]/.test(value) ? value.normalize('NFC') : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const safeHint = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9 ._+/-]{1,40}$/.test(value) ? value : null;
const source = (track: any): ConversionSourceManifest['tracks'][number] => {
    const id = String(track._id), fields = adminCatalogEditableFields('audioTrack', track);
    // Legacy format names are merely hints. Eligibility comes from the client's complete FLAC/PCM decode.
    const format = track.audioMetadata?.format;
    return { id, albumId: conversionId(track.albumId) ? track.albumId : null, revision: adminCatalogItemRevision('audioTrack', track),
        sourceRevision: conversionTrackSourceRevision(track), title: fields.title as string, originalFileName: basename(track.originalFileName),
        format: { container: safeHint(format?.container ?? track.format?.type), codec: safeHint(format?.codec), lossless: typeof format?.lossless === 'boolean' ? format.lossless : null,
            sampleRate: finite(format?.sampleRate), channels: finite(format?.numberOfChannels), bitDepth: finite(format?.bitsPerSample), duration: finite(format?.duration) },
        mediaUrl: `/api/admin/v1/catalog/audioTrack/${id}/media` };
};

/** Reads the fixed ordered Album and both sides of every relationship in one snapshot. */
export async function readConversionAlbum(albumId: string, session: ClientSession) {
    requireId(albumId); const album = await readAdminCatalogRecord('album', albumId, session);
    if (!album) return conversionFail(404, 'ADMIN_CONVERSION_SOURCE_UNAVAILABLE');
    const ids = members(album);
    const tracks = ids.length ? await getDb()!.collection('audioTracks').find({ _id: { $in: ids.map(id => new ObjectId(id)) }, ...readyAudioStorageFilter }, { session, maxTimeMS: 3000 }).limit(CONVERSION_MAX_FILES + 1).toArray() : [];
    const byId = new Map(tracks.map(track => [String(track._id), track]));
    if (tracks.length !== ids.length || tracks.some(track => track.albumId !== albumId || !audio(track))) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_UNAVAILABLE');
    return { album, ids, tracks: ids.map(id => byId.get(id)!) };
}
function albumDto(album: any, ids: string[]) {
    return { id: String(album._id), title: adminCatalogEditableFields('album', album).title as string,
        revision: adminCatalogItemRevision('album', album), membershipRevision: conversionAlbumMembershipRevision(ids) };
}
export const getConversionAlbumSource = (actor: string, albumId: string): Promise<ConversionSourceManifest> => withCurrentAdministrator(actor, async session => {
    const { album, ids, tracks } = await readConversionAlbum(albumId, session);
    return { schemaVersion: 1, album: albumDto(album, ids), tracks: tracks.map(source) };
});
export const getConversionTrackSource = (actor: string, trackId: string): Promise<ConversionSourceManifest> => withCurrentAdministrator(actor, async session => {
    requireId(trackId); const track = await readAdminCatalogRecord('audioTrack', trackId, session);
    if (!audio(track)) return conversionFail(404, 'ADMIN_CONVERSION_SOURCE_UNAVAILABLE');
    if (track!.albumId) {
        if (!conversionId(track!.albumId)) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_UNAVAILABLE');
        const { album, ids } = await readConversionAlbum(track!.albumId, session);
        if (!ids.includes(trackId)) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_UNAVAILABLE');
        return { schemaVersion: 1, album: albumDto(album, ids), tracks: [source(track)] };
    }
    return { schemaVersion: 1, album: null, tracks: [source(track)] };
});

/** Each item checks its own frozen bytes; earlier replacements in the same Album do not change this fence. */
export async function assertConversionSource(trackId: string, intent: ConversionIntent, session: ClientSession) {
    requireId(trackId); const track = await readAdminCatalogRecord('audioTrack', trackId, session);
    if (!audio(track)) return conversionFail(409, 'ADMIN_CONVERSION_SOURCE_UNAVAILABLE');
    if (adminCatalogItemRevision('audioTrack', track) !== intent.expectedRevision || conversionTrackSourceRevision(track) !== intent.sourceRevision) return conversionFail(409, 'ADMIN_CONVERSION_SOURCE_CHANGED');
    if ((track!.albumId || null) !== (intent.album?.id ?? null)) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_CHANGED');
    if (intent.album) {
        const { album, ids } = await readConversionAlbum(intent.album.id, session);
        if (!ids.includes(trackId) || conversionAlbumMembershipRevision(ids) !== intent.album.membershipRevision) return conversionFail(409, 'ADMIN_CONVERSION_MEMBERSHIP_CHANGED');
        if (adminCatalogItemRevision('album', album) !== intent.album.revision) return conversionFail(409, 'ADMIN_CONVERSION_SOURCE_CHANGED');
    }
    return track!;
}
