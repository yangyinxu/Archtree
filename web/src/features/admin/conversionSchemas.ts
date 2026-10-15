import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const revision = z.string().regex(/^cr_[A-Za-z0-9_-]{43}$/);
const bytes = z.number().int().positive().max(512 * 1024 ** 2);
export const conversionAlbumSchema = z.object({ id, title: z.string().max(1000), revision,
  membershipRevision: z.string().regex(/^cm_[A-Za-z0-9_-]{43}$/) }).strict();
export const conversionTrackSchema = z.object({ id, albumId: id.nullable(), revision,
  sourceRevision: z.string().regex(/^mr_[a-f0-9]{32}$/), title: z.string().max(1000), originalFileName: z.string().max(255).nullable(),
  format: z.object({ container: z.string().nullable(), codec: z.string().nullable(), lossless: z.boolean().nullable(),
    sampleRate: z.number().nullable(), channels: z.number().nullable(), bitDepth: z.number().nullable(), duration: z.number().nullable() }).strict(),
  mediaUrl: z.string().regex(/^\/api\/admin\/v1\/catalog\/audioTrack\/[a-f0-9]{24}\/media$/)
}).strict().refine(track => track.mediaUrl === `/api/admin/v1/catalog/audioTrack/${track.id}/media`);
export const conversionManifestSchema = z.object({ schemaVersion: z.literal(1), album: conversionAlbumSchema.nullable(),
  tracks: z.array(conversionTrackSchema).max(100) }).strict().refine(item => (item.album !== null || item.tracks.length > 0)
    && new Set(item.tracks.map(track => track.id)).size === item.tracks.length);
export const conversionOutputSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: bytes, preset: z.literal('mp3-320') }).strict();
export const conversionReceiptSchema = z.object({ schemaVersion: z.literal(1), operation: z.object({
  operationId: z.uuid(), trackId: id, status: z.enum(['awaitingUpload', 'uploading', 'needsAttention', 'complete', 'superseded']),
  upload: z.enum(['notStarted', 'pending', 'ready', 'failed', 'unknown']), publication: z.enum(['notStarted', 'ready', 'failed', 'unknown']),
  ready: z.boolean(), cleanupPending: z.boolean(), issue: z.string().nullable(), output: conversionOutputSchema
}).strict() }).strict();
export type ConversionManifest = z.infer<typeof conversionManifestSchema>;
export type ConversionTrack = z.infer<typeof conversionTrackSchema>;
export type ConversionReceipt = z.infer<typeof conversionReceiptSchema>['operation'];
export const conversionImportProofSchema = z.object({ schemaVersion: z.literal(1), projectId: id,
  publicationOperationId: z.uuid().nullable(), ready: z.array(z.object({ slotId: z.uuid(), trackId: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: bytes }).strict()).max(100) }).strict();
export interface ConversionIntent {
  operationId: string; expectedRevision: string; sourceRevision: string; sourceEtag: string; sourceByteLength: number;
  album: Omit<NonNullable<ConversionManifest['album']>, 'title'> | null;
  output: z.infer<typeof conversionOutputSchema> & { filename: string };
}
