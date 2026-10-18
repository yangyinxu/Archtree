import type { MediaRepresentation } from '../../models/mediaRepresentation';
import { ADMIN_IMPORT_LIMITS, type ImportDraft, type ImportDuplicateDecision, type ImportEmbeddedTags } from './adminImportContract';
import type { ImportDecisionV2, ImportDraftV2 } from './adminImportDraft';

/** Stage objects are never AudioTrack rows, so ordinary publication recovery cannot expose a draft. */
export interface ImportAsset {
    slotId: string; operationId: string; actorId: string; bucket: string; key: string; sha256: string; byteLength: number; contentType: string; filename: string;
    state: 'pending' | 'ready' | 'failed' | 'unknown' | 'deleting' | 'cleanupFailed' | 'deleted';
    versionId: string | null; etag: string | null; updatedAt: Date; leaseOwner: string | null; leaseUntil: Date | null;
    duration: string | null; format: string | null; representation: MediaRepresentation | null;
    tags: ImportEmbeddedTags | null;
    coverConsumers?: string[];
    /** No PUT for this admission can land after this time; legacy records fall back to updatedAt plus the settle window. */
    transferDeadline?: Date | null;
    /** Set only by storage reconciliation, never by a transfer error: a confirmed failure is replaceable. */
    failureConfirmedAt?: Date | null;
    recovery: { operationId: string; expectedRevision: number; kind: 'upload' | 'cleanup'; actorId: string };
}
export interface ImportPublication {
    /** Frozen approval format: absent means 1 (a v1 snapshot); 2 freezes a Draft v2 snapshot and entry-bound decisions. */
    schemaVersion?: number;
    operationId: string; actorId: string; approvedRevision: number; snapshot: ImportDraft | ImportDraftV2; decisions: ImportDuplicateDecision[] | ImportDecisionV2[];
    state: 'preparing' | 'needsAttention' | 'complete' | 'cancelled'; issue: 'storageUnknown' | 'permissionLost' | 'catalogConflict' | 'configurationUnavailable' | 'unsupportedVersion' | null;
    cleanupPending?: boolean;
    cancellation?: { operationId: string; actorId: string };
    grantExpiresAt: Date; artistId: string; newArtist: boolean; albumId: string; newAlbum: boolean; albumRevision: string | null; coverId: string | null;
    tracks: { slotId: string; id: string; key: string; reused: boolean; candidateRevision: string | null; state: 'pending' | 'ready' | 'unknown'; versionId: string | null; etag: string | null; cleanupComplete?: boolean }[];
    cover: { slotId: string; key: string; state: 'pending' | 'ready' | 'unknown'; versionId: string | null; etag: string | null; cleanupComplete?: boolean } | null;
    bucket: string; leaseOwner: string | null; leaseUntil: Date | null;
}
export interface ImportMedia { assets: ImportAsset[]; assetHistory?: ImportAsset[]; selectedCoverSlotId?: string | null; publication?: ImportPublication; publicationHistory?: ImportPublication[] }
/** Stored format number: absent or null is the original format 1; anything but a positive safe integer is unrecognized (null). */
export const importFormatVersion = (value: unknown): number | null => value === undefined || value === null ? 1 : Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
export const importPublicationVersion = (publication: { schemaVersion?: unknown }): number | null => importFormatVersion(publication.schemaVersion);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/**
 * The approval format this release copies, commits and cleans, or null (it stays needs attention). Each format fails closed
 * on shape too. Format 1 needs a v1 snapshot (a string artistName, no artist entries, no Disc Numbers), so an approval a later
 * release froze without recording its format is never misread as format 1. Format 2 needs a Draft v2 snapshot with exactly one
 * primary Artist entry, no label and a `discNumber` field (a Disc Number or null) on every track. Any other shape needs a higher
 * schemaVersion, so S7a writes 3 for several entries or a label.
 */
export const importPublicationFormat = (publication: { schemaVersion?: unknown; snapshot?: unknown }): 1 | 2 | null => {
    const version = importPublicationVersion(publication);
    if ((version !== 1 && version !== 2) || !isRecord(publication.snapshot)) return null;
    const { album, tracks } = publication.snapshot;
    if (!isRecord(album) || !Array.isArray(tracks) || !tracks.every(isRecord)) return null;
    if (version === 1) return typeof album.artistName === 'string' && !('artists' in album) && tracks.every(track => !('discNumber' in track)) ? 1 : null;
    const artists = album.artists;
    return !('artistName' in album) && Array.isArray(artists) && artists.length === 1 && isRecord(artists[0]) && artists[0].role === 'primary' && typeof artists[0].name === 'string'
        && album.label === null && tracks.every(track => 'discNumber' in track) ? 2 : null;
};
export const importPublicationSupported = (publication: { schemaVersion?: unknown; snapshot?: unknown }) => importPublicationFormat(publication) !== null;
/** A missing object proves failure only once no PUT can still land: lease released/expired and transfer deadline passed. */
export const importUploadSettled = (asset: ImportAsset, now: Date) =>
    (!asset.leaseUntil || asset.leaseUntil <= now) &&
    now.getTime() >= (asset.transferDeadline?.getTime() ?? asset.updatedAt.getTime() + ADMIN_IMPORT_LIMITS.uploadSettleMs);
/** Sources stay locked while a publication is active or its cancelled cleanup is pending. */
export const importSourcesLocked = (media?: ImportMedia) => Boolean(media?.publication && (media.publication.state !== 'cancelled' || media.publication.cleanupPending));
/** A deployment assertion is mandatory: a private ACL does not override a public bucket/CDN policy. */
export const importPrivateStorageReady = () => process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY === 'true' && Boolean(process.env.ADMIN_IMPORT_S3_BUCKET_NAME?.trim()) && process.env.ADMIN_IMPORT_S3_BUCKET_NAME?.trim() !== process.env.S3_BUCKET_NAME?.trim();
