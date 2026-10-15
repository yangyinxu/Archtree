import { z } from 'zod';
import { adminEndpointRequest, type AdminGuard } from './adminTransport';
import { conversionManifestSchema, conversionReceiptSchema, conversionImportProofSchema, type ConversionIntent } from './conversionSchemas';
export * from './conversionSchemas';
const id = z.string().regex(/^[a-f0-9]{24}$/);

/** Receipts describe the frozen operation, rather than whichever track happens to be current. */
export const conversionApi = {
  source(kind: 'albums' | 'tracks', value: string, guard: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(`/conversions/${kind}/${id.parse(value)}/source`, conversionManifestSchema, { signal }, guard);
  },
  prepare(trackId: string, intent: ConversionIntent, guard: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(`/conversions/tracks/${id.parse(trackId)}/operations`, conversionReceiptSchema,
      { method: 'POST', body: JSON.stringify(intent), signal }, guard);
  },
  read(trackId: string, operationId: string, guard: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(`/conversions/tracks/${id.parse(trackId)}/operations/${z.uuid().parse(operationId)}`, conversionReceiptSchema, { signal }, guard);
  },
  reconcile(trackId: string, operationId: string, guard: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(`/conversions/tracks/${id.parse(trackId)}/operations/${z.uuid().parse(operationId)}/reconcile`, conversionReceiptSchema,
      { method: 'POST', body: '{}', signal }, guard);
  },
  cancel(trackId: string, operationId: string, guard: AdminGuard, signal?: AbortSignal) {
    return adminEndpointRequest(`/conversions/tracks/${id.parse(trackId)}/operations/${z.uuid().parse(operationId)}/cancel`, conversionReceiptSchema,
      { method: 'POST', body: '{}', signal }, guard);
  },
  upload(trackId: string, operationId: string, file: File, guard: AdminGuard, signal?: AbortSignal) {
    // The JSON transport sets a default Content-Type; freeze a bounded multipart envelope explicitly.
    const boundary = `FinitudeConversion-${z.uuid().parse(operationId)}`;
    const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    const body = new Blob([`--${boundary}\r\nContent-Disposition: form-data; name="audioFile"; filename="output.mp3"; filename*=UTF-8''${name}\r\nContent-Type: audio/mpeg\r\n\r\n`, file, `\r\n--${boundary}--\r\n`]);
    return adminEndpointRequest(`/conversions/tracks/${id.parse(trackId)}/operations/${z.uuid().parse(operationId)}/upload`, conversionReceiptSchema,
      { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, signal }, guard);
  },
  importProof(projectId: string, guard: AdminGuard, signal?: AbortSignal, slots?: string[]) {
    return adminEndpointRequest(`/conversions/imports/${id.parse(projectId)}/ready`, conversionImportProofSchema,
      slots ? { method: 'POST', body: JSON.stringify({ slots: z.array(z.uuid()).min(1).max(100).parse(slots) }), signal } : { signal }, guard);
  }
};
