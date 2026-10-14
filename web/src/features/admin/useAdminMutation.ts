import { useState, useSyncExternalStore } from 'react';
import { ApiError } from '../../api/client';
import { adminWorkspace } from './adminWorkspace';
import { adminRequest, responseSchema, type ImportDetail, type ImportResponse } from './adminApi';

interface Intent { path: string; method: string; body?: BodyInit; headers?: Record<string, string>; operationId: string }
/** A reservation receipt is not proof that staged bytes were stored or removed. */
const assetFinished = (intent: Intent, item: ImportDetail) => {
  const match = /\/assets\/([^/]+)$/.exec(intent.path);
  if (!match) return true;
  const asset = item.assets.find(asset => asset.slotId === decodeURIComponent(match[1]));
  if (asset?.recovery?.operationId !== intent.operationId || asset.recovery.kind !== (intent.method === 'DELETE' ? 'cleanup' : 'upload')) return false;
  return intent.method === 'DELETE' ? asset?.state === 'deleted' : asset?.state === 'ready';
};
const mediaType = (file: File) => {
  const types: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return types[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
};
interface Snapshot { running: boolean; intent: Intent | null; error: 'unknown' | 'conflict' | 'error' | null; result: ImportResponse | null }
/** One immutable intent survives navigation and lost responses; retries never invent a second paid job. */
export class AdminMutation {
  private state: Snapshot = { running: false, intent: null, error: null, result: null };
  private listeners = new Set<() => void>();
  private owner = adminWorkspace.capture();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(next: Snapshot) { this.state = next; for (const fn of this.listeners) fn(); }
  run(path: string, method: string, payload: object) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    const operationId = crypto.randomUUID();
    const intent = { path, method, operationId, body: JSON.stringify({ ...payload, operationId }) };
    void this.send(intent);
  }
  asset(path: string, expectedRevision: number, file?: File, recovery?: { operationId: string; expectedRevision: number; startedByMe: boolean; kind: 'upload' | 'cleanup' } | null) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    // Only the admitting administrator may resend upload bytes; exact detached cleanup is shared.
    if (recovery && (file && !recovery.startedByMe || recovery.kind !== (file ? 'upload' : 'cleanup'))) return;
    const operationId = recovery?.operationId ?? crypto.randomUUID();
    const headers: Record<string, string> = { 'Idempotency-Key': operationId, 'If-Match': String(recovery?.expectedRevision ?? expectedRevision) };
    let body: Blob | undefined;
    if (file) {
      const boundary = `FinitudeImport-${operationId}`;
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      const filename = encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
      body = new Blob([`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"; filename*=UTF-8''${filename}\r\nContent-Type: ${mediaType(file)}\r\n\r\n`, file, `\r\n--${boundary}--\r\n`]);
    }
    void this.send({ path, method: file ? 'POST' : 'DELETE', headers, body, operationId });
  }
  resume(path: string, operationId: string) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    void this.send({ path, method: 'POST', operationId, body: JSON.stringify({ operationId }) });
  }
  retry = () => { if (this.state.intent && !this.state.running) void this.send(this.state.intent); };
  acknowledge() { this.set({ ...this.state, result: null }); }
  reconcile(item: ImportDetail) {
    const intent = this.state.intent;
    if (!this.state.running && intent && assetFinished(intent, item) && item.receipts.some(receipt => receipt.operationId === intent.operationId)) {
      this.set({ running: false, intent: null, error: null, result: { item, receipt: item.receipts.find(receipt => receipt.operationId === intent.operationId)! } });
    }
  }
  private async send(intent: Intent) {
    if (!adminWorkspace.current(this.owner, false)) return;
    const guard = adminWorkspace.capture();
    this.set({ running: true, intent, error: null, result: null });
    try {
      const result = await adminRequest(intent.path, responseSchema, { method: intent.method, body: intent.body, headers: intent.headers }, guard);
      if (!adminWorkspace.current(this.owner, false)) return;
      if (result.receipt?.operationId !== intent.operationId) throw new ApiError('Unconfirmed operation', 'invalid-response');
      const complete = assetFinished(intent, result.item);
      this.set({ running: false, intent: complete ? null : intent, error: complete ? null : 'unknown', result });
    } catch (error) {
      if (!adminWorkspace.current(this.owner, false)) return;
      const rejected = error instanceof ApiError && error.kind === 'http' && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0);
      this.set({ running: false, intent: rejected ? null : intent, error: rejected ? (error instanceof ApiError && error.status === 409 ? 'conflict' : 'error') : 'unknown', result: null });
    }
  }
}
export function useAdminMutation(key: string) {
  const [operation] = useState(() => {
    const previous = adminWorkspace.buffer<AdminMutation>(`mutation:${key}`);
    if (previous) return previous;
    const next = new AdminMutation(); adminWorkspace.retain(`mutation:${key}`, next, adminWorkspace.capture()); return next;
  });
  return { operation, ...useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot) };
}
