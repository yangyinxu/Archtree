import { z } from 'zod';

import { adminEndpointRequest, type AdminGuard } from './adminTransport';

const trackId = z.string().regex(/^[a-f0-9]{24}$/);

export const motionPreviewStatusSchema = z.object({
  eligible: z.boolean(),
  sourceToken: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  revision: z.number().int().nonnegative(),
  active: z.object({
    revision: z.string().regex(/^pv_[0-9a-f]{32}$/),
    byteLength: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    current: z.boolean(),
    updatedAt: z.string()
  }).strict().nullable(),
  pending: z.object({
    status: z.enum(['uploading', 'failed']),
    outcomeUnknown: z.boolean(),
    leaseActive: z.boolean()
  }).strict().nullable(),
  cleanup: z.object({
    status: z.enum(['pending', 'deleteFailed']),
    reason: z.enum(['replaced', 'stale', 'removed'])
  }).strict().nullable()
}).strict();

export type MotionPreviewStatus = z.infer<typeof motionPreviewStatusSchema>;

const uploadResultSchema = z.object({
  revision: z.string().regex(/^pv_[0-9a-f]{32}$/),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  cleanupPending: z.boolean()
}).strict();

const cleanupResultSchema = z.object({ cleanupPending: z.boolean() }).strict();

const path = (id: string) => `/catalog/audioTrack/${trackId.parse(id)}/motion-preview`;

/** Administrator motion-preview endpoints for one Video MediaTrack. */
export const motionPreviewApi = {
  status(id: string, guard?: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(path(id), motionPreviewStatusSchema, { signal }, guard);
  },
  upload(id: string, file: File, status: Pick<MotionPreviewStatus, 'sourceToken' | 'revision'>, guard?: AdminGuard) {
    // The JSON transport sets a default Content-Type; freeze a bounded multipart envelope explicitly.
    const boundary = `FinitudeMotionPreview-${crypto.randomUUID()}`;
    const field = (name: string, value: string) => (
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
    const body = new Blob([
      field('sourceToken', z.string().regex(/^[0-9a-f]{32}$/).parse(status.sourceToken)),
      field('expectedRevision', String(status.revision)),
      `--${boundary}\r\nContent-Disposition: form-data; name="motionPreviewFile"; filename="preview.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
      file,
      `\r\n--${boundary}--\r\n`
    ]);
    return adminEndpointRequest(path(id), uploadResultSchema, {
      method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    }, guard);
  },
  remove(id: string, expectedRevision: number, guard?: AdminGuard) {
    return adminEndpointRequest(path(id), cleanupResultSchema, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision })
    }, guard);
  },
  reconcile(id: string, guard?: AdminGuard) {
    return adminEndpointRequest(`${path(id)}/reconcile`, cleanupResultSchema, { method: 'POST' }, guard);
  }
};
