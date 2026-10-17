import type { MediaRepresentation } from '../../models/mediaRepresentation';
import type { ImportDraft, ImportDuplicateDecision, ImportEmbeddedTags } from './adminImportContract';

/** Stage objects are never AudioTrack rows, so ordinary publication recovery cannot expose a draft. */
export interface ImportAsset {
    slotId: string; operationId: string; actorId: string; bucket: string; key: string; sha256: string; byteLength: number; contentType: string; filename: string;
    state: 'pending' | 'ready' | 'failed' | 'unknown' | 'deleting' | 'cleanupFailed' | 'deleted';
    versionId: string | null; etag: string | null; updatedAt: Date; leaseOwner: string | null; leaseUntil: Date | null;
    duration: string | null; format: string | null; representation: MediaRepresentation | null;
    tags: ImportEmbeddedTags | null;
    coverConsumers?: string[];
    recovery: { operationId: string; expectedRevision: number; kind: 'upload' | 'cleanup'; actorId: string };
}
export interface ImportPublication {
    operationId: string; actorId: string; approvedRevision: number; snapshot: ImportDraft; decisions: ImportDuplicateDecision[];
    state: 'preparing' | 'needsAttention' | 'complete' | 'cancelled'; issue: 'storageUnknown' | 'permissionLost' | 'catalogConflict' | 'configurationUnavailable' | null;
    cleanupPending?: boolean;
    cancellation?: { operationId: string; actorId: string };
    grantExpiresAt: Date; artistId: string; newArtist: boolean; albumId: string; newAlbum: boolean; albumRevision: string | null; coverId: string | null;
    tracks: { slotId: string; id: string; key: string; reused: boolean; candidateRevision: string | null; state: 'pending' | 'ready' | 'unknown'; versionId: string | null; etag: string | null; cleanupComplete?: boolean }[];
    cover: { slotId: string; key: string; state: 'pending' | 'ready' | 'unknown'; versionId: string | null; etag: string | null; cleanupComplete?: boolean } | null;
    bucket: string; leaseOwner: string | null; leaseUntil: Date | null;
}
export interface ImportMedia { assets: ImportAsset[]; assetHistory?: ImportAsset[]; selectedCoverSlotId?: string | null; publication?: ImportPublication; publicationHistory?: ImportPublication[] }
/** A deployment assertion is mandatory: a private ACL does not override a public bucket/CDN policy. */
export const importPrivateStorageReady = () => process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY === 'true' && Boolean(process.env.ADMIN_IMPORT_S3_BUCKET_NAME?.trim()) && process.env.ADMIN_IMPORT_S3_BUCKET_NAME?.trim() !== process.env.S3_BUCKET_NAME?.trim();
