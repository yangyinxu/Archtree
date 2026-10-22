import { z } from 'zod';
import { ApiError } from '../../api/client';
import { adminEndpointRequest, type AdminGuard } from './adminTransport';
import { ADMIN_RELOAD_REQUIRED } from './adminWorkspace';
import type { CatalogKind } from './catalogApi';

/** The server's absolute image ceiling (imageUpload.ts absoluteMaxImageUploadMb); the server enforces its configured limit. */
export const COVER_UPLOAD_CEILING_BYTES = 25 * 1024 * 1024;
export type CoverUploadType = 'image/jpeg' | 'image/png' | 'image/webp';
/** The one in-memory copy of a chosen file: the request, every retry and the preview are built from it, never from the File. */
export interface CoverUpload { bytes: Blob; type: CoverUploadType; filename: string }
export type CoverUploadMessage = 'cover.upload_type' | 'cover.upload_invalid' | 'cover.upload_too_large' | 'cover.upload_unknown' | 'cover.upload_busy'
  | 'cover.upload_limit' | 'cover.upload_unavailable' | 'common.conflict' | 'common.error' | 'common.reload';

const uploadSchema = z.object({ upload: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).strict(), receipt: z.object({ operationId: z.string() }).strict() }).strict();
const starts = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);

/** Declares the type from the file signature only (as the server's allowed image types do); the name and File.type are never read. */
export function coverUploadType(head: Uint8Array): CoverUploadType | null {
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Reads a chosen file once, refusing an empty, oversized, unreadable or unsupported file, or an unencodable name, before anything is sent. */
export async function readCoverUpload(file: File): Promise<CoverUpload | { refusal: CoverUploadMessage }> {
  if (file.size < 1) return { refusal: 'cover.upload_invalid' };
  if (file.size > COVER_UPLOAD_CEILING_BYTES) return { refusal: 'cover.upload_too_large' };
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); } catch { return { refusal: 'cover.upload_invalid' }; }
  if (buffer.byteLength < 1) return { refusal: 'cover.upload_invalid' };
  if (buffer.byteLength > COVER_UPLOAD_CEILING_BYTES) return { refusal: 'cover.upload_too_large' };
  const type = coverUploadType(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)));
  if (!type) return { refusal: 'cover.upload_type' };
  // A name with an unpaired UTF-16 surrogate cannot be encoded for the request; refuse it here rather than offer a Retry that always fails.
  try { encodeURIComponent(file.name); } catch { return { refusal: 'cover.upload_invalid' }; }
  return { bytes: new Blob([buffer], { type }), type, filename: file.name };
}

/** Builds the exact multipart request of one intent; a retry of that intent rebuilds identical bytes. */
export function catalogCoverUploadRequest(upload: CoverUpload, operationId: string): { headers: Record<string, string>; body: Blob } {
  const boundary = `FinitudeCover-${operationId}`;
  const filename = encodeURIComponent(upload.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
  return {
    headers: { 'Idempotency-Key': operationId, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: new Blob([`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"; filename*=UTF-8''${filename}\r\nContent-Type: ${upload.type}\r\n\r\n`, upload.bytes, `\r\n--${boundary}--\r\n`])
  };
}

/** Stages one upload privately and returns its id; a receipt naming another key is unconfirmed (unknown). */
export async function uploadCatalogCover(kind: CatalogKind, id: string, upload: CoverUpload, operationId: string, guard: AdminGuard): Promise<string> {
  const result = await adminEndpointRequest(`/catalog/${kind}/${id}/cover-uploads`, uploadSchema, { method: 'POST', ...catalogCoverUploadRequest(upload, operationId) }, guard);
  if (result.receipt.operationId !== operationId) throw new ApiError('Unconfirmed receipt', 'invalid-response');
  return result.upload.id;
}

/** Maps a failed upload to its message, and whether its intent is kept for Retry (an unknown outcome) or dropped (definite). */
export function coverUploadRefusal(error: unknown): { message: CoverUploadMessage; keep: boolean } {
  if (error instanceof ApiError && error.code === ADMIN_RELOAD_REQUIRED) return { message: 'common.reload', keep: false };
  if (!(error instanceof ApiError) || error.kind !== 'http') return { message: 'cover.upload_unknown', keep: true };
  const { status = 0, code } = error;
  if (status === 413) return { message: 'cover.upload_too_large', keep: false };
  if (status === 429) return code === 'ADMIN_CATALOG_COVER_UPLOAD_LIMIT' ? { message: 'cover.upload_limit', keep: false } : { message: 'cover.upload_busy', keep: true };
  if (status === 409) return code === 'ADMIN_CATALOG_COVER_UPLOAD_BUSY' ? { message: 'cover.upload_unknown', keep: true } : { message: 'common.conflict', keep: false };
  if (status === 400 && code === 'ADMIN_CATALOG_COVER_INVALID_IMAGE') return { message: 'cover.upload_invalid', keep: false };
  if (status === 503 && code === 'ADMIN_IMPORT_STORAGE_UNAVAILABLE') return { message: 'cover.upload_unavailable', keep: false };
  if (status >= 500) return { message: 'cover.upload_unknown', keep: true };
  return { message: 'common.error', keep: false };
}
