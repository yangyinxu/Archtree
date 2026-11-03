import { z } from 'zod';
import type { ApiResponseTransport, UploadProgress } from '../../api/client';
import { adminEndpointRequest, type AdminGuard } from './adminTransport';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const operationId = z.string().uuid();
const revision = z.number().int().nonnegative();
export const videoDraftSchema = z.object({
  title: z.string(), attribution: z.enum(['self', 'catalog', 'unknown']), publicName: z.string(),
  subjectType: z.enum(['artist', 'organization']), subjectId: id.nullable(), albumId: id.nullable(),
    visibility: z.enum(['public', 'hidden']), coverChoice: z.union([z.literal('automatic'), z.literal('none'), id])
}).strict();
const reference = z.object({ id, name: z.string(), revision: z.string() }).strict();
const ingress = z.object({ operationId, expectedRevision: revision, state: z.enum(['receiving', 'admitted', 'failed']), issue: z.string().nullable() }).strict();
export const videoProjectSchema = z.object({
  id, revision, createdAt: z.string(), updatedAt: z.string(),
  stage: z.enum(['prepare', 'upload', 'validate', 'review', 'publish', 'complete', 'cancelled']),
  draft: videoDraftSchema,
  ingress: z.object({ source: ingress.nullable(), cover: ingress.nullable() }).strict(),
  source: z.object({ filename: z.string(), byteLength: z.number().int().positive(), status: z.enum(['idle', 'pending', 'ready', 'unknown', 'failed', 'deleted']), operationId: operationId.nullable() }).strict(),
  processing: z.object({ state: z.enum(['idle', 'queued', 'running', 'ready', 'failed']), plan: z.enum(['pending', 'direct', 'remux', 'transcode']), step: z.enum(['inspect', 'validate', 'adapt', 'cover']).nullable(), progress: z.number().min(0).max(100).nullable(), issue: z.string().nullable(),
    facts: z.object({ plan: z.enum(['direct', 'remux', 'transcode']), durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), videoCodec: z.string(), audioCodec: z.string().nullable() }).strict().nullable()
  }).strict(),
  frame: z.object({ state: z.enum(['idle', 'queued', 'running', 'ready', 'failed']), issue: z.string().nullable() }).strict(),
  covers: z.array(z.object({ id, name: z.string(), source: z.enum(['embedded', 'frame', 'custom']), previewUrl: z.string(), state: z.enum(['ready', 'unknown', 'failed', 'deleted']), operationId }).strict()),
  selectedCoverId: id.nullable(),
  publication: z.object({ state: z.enum(['idle', 'queued', 'running', 'complete', 'failed', 'cancelled']), mediaTrackId: id.nullable(), coverUrl: z.string().nullable(), issue: z.string().nullable(), cleanupPending: z.boolean(), operationId: operationId.nullable() }).strict(),
  approvalDigest: z.string().nullable(),
  references: z.object({ subject: reference.nullable(), album: z.object({ id, title: z.string(), revision: z.string(), visibility: z.enum(['public', 'hidden']), coverUrl: z.string().nullable() }).strict().nullable() }).strict()
}).strict().refine(item => item.covers.every(cover => cover.previewUrl.split('?')[0] === `/api/admin/v1/video-projects/${item.id}/covers/${cover.id}/preview`)
  && (!item.references.album?.coverUrl || item.references.album.coverUrl.split('?')[0] === `/api/admin/v1/catalog/album/${item.references.album.id}/artwork`)
  && (!item.publication.coverUrl || item.publication.state === 'complete' && item.publication.mediaTrackId && item.publication.coverUrl.split('?')[0] === `/api/admin/v1/catalog/audioTrack/${item.publication.mediaTrackId}/artwork`), 'Invalid private cover source');
const receipt = z.object({ operationId, revision }).strict();
export const videoResponseSchema = z.object({ schemaVersion: z.literal(1), item: videoProjectSchema, receipt: receipt.optional() }).strict();
export const videoMutationSchema = videoResponseSchema.extend({ receipt });
export const videoListSchema = z.object({ schemaVersion: z.literal(1), items: z.array(videoProjectSchema).max(25), nextCursor: z.string().nullable() }).strict();
export type VideoProject = z.infer<typeof videoProjectSchema>;
export type VideoDraft = z.infer<typeof videoDraftSchema>;
export const videoPath = (projectId: string) => `/video-projects/${id.parse(projectId)}`;
/** Private artwork always carries the current viewer fence, including a return from another account. */
export const videoCoverUrl = (url: string, viewer: string) => `${url.split('?')[0]}?viewer=${encodeURIComponent(viewer)}`;

/** The immutable multipart envelope can be retried with the same operation and exact original bytes. */
export function videoUploadRequest(file: Blob, filename: string, intent: string, expectedRevision: number) {
  const boundary = `FinitudeVideo-${operationId.parse(intent)}`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
  return {
    headers: { 'Idempotency-Key': intent, 'If-Match': String(expectedRevision), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: new Blob([`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"; filename*=UTF-8''${encoded}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`, file, `\r\n--${boundary}--\r\n`])
  };
}

/** Reads an authoritative project, without retrying or sending media bytes. */
export const readVideoProject = (projectId: string, signal?: AbortSignal) => adminEndpointRequest(videoPath(projectId), videoResponseSchema.refine(result => result.item.id === projectId), { signal });

/** Only a matching server receipt confirms a transfer; losing the response leaves its original intent intact. */
export async function uploadVideoFile(projectId: string, kind: 'source' | 'covers', file: Blob, filename: string, intent: string, expectedRevision: number, guard: AdminGuard, onUploadProgress?: (progress: UploadProgress) => void) {
  const responseTransport: ApiResponseTransport | undefined = onUploadProgress ? async (path, init, headers, assertCurrent) => {
    const { uploadResponse } = await import('../../api/uploadResponse');
    assertCurrent?.();
    return uploadResponse(path, init, headers, onUploadProgress, assertCurrent);
  } : undefined;
  const result = await adminEndpointRequest(`${videoPath(projectId)}/${kind}`, videoMutationSchema.refine(result => result.item.id === projectId),
    { method: 'POST', ...videoUploadRequest(file, filename, intent, expectedRevision), responseTransport }, guard);
  if (result.receipt.operationId !== intent) throw new Error('Unconfirmed video transfer');
  return result;
}
