/**
 * Whether a published Track still holds exactly the file an import staged for it: the byte proof local MP3 conversion makes before
 * a local result may be removed (conversionImportProof.ts) and an existing-Album review makes before it captures the evidence of
 * the import that published its Album (adminCatalogReviewImportEvidence.ts). Each caller adds its own conditions on top. Pure.
 */
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import { isAudioObjectKeyForTrack } from '../../utils/audioStorageKey';

/** The proven media: the staged file's hash and length, and the Track's active object key, etag and version. */
export type PublishedImportMedia = { sha256: string; byteLength: number; key: string; etag: string; versionId: string | null };

const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** An audio media type such as `audio/flac` or `audio/mpeg`. */
export const anyAudioContentType = (value: unknown): boolean => typeof value === 'string' && /^audio\/[a-z0-9][a-z0-9.+-]{0,99}$/i.test(value);
/** A stored object etag: one quoted value without quotes or line breaks inside, as storage reports it. */
const storedEtag = (value: unknown): value is string => typeof value === 'string' && /^"[^"\r\n]{1,200}"$/.test(value);

/**
 * Whether `track` still holds exactly the file an import staged as `asset` for the published Track `trackId`: an audio Track whose
 * active key belongs to it, of an accepted content type (`contentType`, any audio type by default), whose sha256 byte hash equals
 * the asset's hash and length (positive, at most `maxBytes`) for that key, with a well-formed etag and version, agreeing with its
 * media representation's key, etag, version and length. Null on any mismatch or malformed value.
 */
export function publishedImportMedia(trackId: string, asset: unknown, track: unknown,
    options: { contentType?: (value: unknown) => boolean; maxBytes?: number } = {}): PublishedImportMedia | null {
    if (!isRecord(asset) || !isRecord(track)) return null;
    const contentType = options.contentType ?? anyAudioContentType, maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const hash = track.mediaByteHash, representation = track.mediaRepresentation;
    const key = activeMediaObjectKeyForTrack(track);
    if (activeMediaTypeForTrack(track) !== 'audio' || !key || !isAudioObjectKeyForTrack(key, trackId)
        || !contentType(track.contentType) || !isRecord(hash) || hash.algorithm !== 'sha256' || typeof hash.value !== 'string' || hash.value !== asset.sha256
        || !/^[a-f0-9]{64}$/.test(hash.value) || hash.byteLength !== asset.byteLength || hash.objectKey !== key
        || !Number.isSafeInteger(hash.byteLength) || hash.byteLength <= 0 || hash.byteLength > maxBytes || !storedEtag(hash.etag)
        || hash.versionId !== null && (typeof hash.versionId !== 'string' || !hash.versionId || hash.versionId.length > 1024 || /[\r\n]/.test(hash.versionId))
        || !isRecord(representation) || hash.etag !== representation.etag || hash.versionId !== representation.versionId
        || representation.objectKey !== key || representation.byteLength !== asset.byteLength) return null;
    return { sha256: hash.value, byteLength: hash.byteLength, key, etag: hash.etag, versionId: hash.versionId };
}
