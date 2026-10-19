import { useState, useSyncExternalStore } from 'react';
import { ApiError } from '../../api/client';
import { ADMIN_RELOAD_REQUIRED, adminWorkspace } from './adminWorkspace';
import { ADMIN_IMPORT_RELOAD_REQUIRED, adminRequest, responseSchema, type ImportDetail, type ImportResponse } from './adminApi';

interface Intent { path: string; method: string; body?: BodyInit; headers?: Record<string, string>; operationId: string }
type AssetRecovery = { operationId: string; expectedRevision: number; startedByMe: boolean; kind: 'upload' | 'cleanup' };
/** A cleanup reservation receipt is not proof that staged bytes were removed. */
const assetFinished = (intent: Intent, item: ImportDetail) => {
  const match = /\/assets\/([^/]+)$/.exec(intent.path);
  if (!match || intent.method !== 'DELETE') return true;
  const asset = item.assets.find(asset => asset.slotId === decodeURIComponent(match[1]));
  return asset?.recovery?.operationId === intent.operationId && asset.recovery.kind === 'cleanup' && asset.state === 'deleted';
};
/** `error` names its message (`common.<error>`): an outcome kind, or a refusal that has its own message (see `ownRefusal`). */
interface Snapshot { running: boolean; intent: Intent | null; error: string | null; result: ImportResponse | null }
/**
 * Refusals with their own message instead of a generic conflict: the metadata lookup refusals (ADMIN_IMPORT_LOOKUP_ACTIVE,
 * …_UNAVAILABLE, …_REFUSED, …_INVALID_NAME, …_NOTHING_TO_RETRY, …_STALE, …_CANDIDATE_INCOMPLETE) and, as a 409, an append whose
 * target Album has no primary Artist Credit; each is `common.<code without ADMIN_IMPORT_, lower case>`. None is an edit conflict,
 * so nothing is retried or reread. Matched by pattern, keeping the codes out of adminTransport.ts, which every admin route loads.
 */
const ownRefusal = /^ADMIN_IMPORT_(LOOKUP_\w+|APPEND_PRIMARY_REQUIRED)$/;
/** One immutable intent survives navigation and lost responses; retries never invent a second paid job. Uploads use the upload queue. */
export class AdminMutation {
  private state: Snapshot = { running: false, intent: null, error: null, result: null };
  private listeners = new Set<() => void>();
  private owner = adminWorkspace.capture();
  /** Runs once when this intent is confirmed, whether or not its page is still mounted; retries keep it. */
  private completion: ((result: ImportResponse) => void) | null = null;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(next: Snapshot) { this.state = next; for (const fn of this.listeners) fn(); }
  run(path: string, method: string, payload: object, onComplete?: (result: ImportResponse) => void) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    this.completion = onComplete ?? null;
    const operationId = crypto.randomUUID();
    const intent = { path, method, operationId, body: JSON.stringify({ ...payload, operationId }) };
    void this.send(intent);
  }
  /** Exact detached cleanup is shared: any current administrator resumes the original cleanup intent. */
  cleanup(path: string, expectedRevision: number, recovery?: AssetRecovery | null) {
    if (this.state.running || this.state.intent || !adminWorkspace.current(this.owner, false)) return;
    if (recovery && recovery.kind !== 'cleanup') return;
    const operationId = recovery?.operationId ?? crypto.randomUUID();
    const headers: Record<string, string> = { 'Idempotency-Key': operationId, 'If-Match': String(recovery?.expectedRevision ?? expectedRevision) };
    void this.send({ path, method: 'DELETE', headers, operationId });
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
      if (complete) { const completion = this.completion; this.completion = null; completion?.(result); }
      this.set({ running: false, intent: complete ? null : intent, error: complete ? null : 'unknown', result });
    } catch (error) {
      if (!adminWorkspace.current(this.owner, false)) return;
      // An outdated bundle cannot read the result, so it offers a reload instead of resending the intent.
      if (error instanceof ApiError && error.code === ADMIN_RELOAD_REQUIRED) { this.completion = null; this.set({ running: false, intent: null, error: 'reload', result: null }); return; }
      // A project saved by a newer release refuses this change before admission; only this action asks for a reload.
      if (error instanceof ApiError && error.kind === 'http' && error.status === 409 && error.code === ADMIN_IMPORT_RELOAD_REQUIRED) { this.completion = null; this.set({ running: false, intent: null, error: 'reload', result: null }); return; }
      const http = error instanceof ApiError && error.kind === 'http' ? error : null, own = ownRefusal.exec(http?.code!)?.[1];
      const rejected = Boolean(own) || [400, 401, 403, 404, 409, 422].includes(http?.status ?? 0);
      if (rejected) this.completion = null;
      // `own > 'B'` holds for every LOOKUP_* code and not for APPEND_PRIMARY_REQUIRED (A sorts before B), so a lookup refusal
      // has its own message at any status while the append refusal has one only as a 409. useAdminMutation.test.ts checks that
      // every such code the server throws has its message.
      this.set({ running: false, intent: rejected ? null : intent, error: own && (own > 'B' || http!.status === 409) ? own.toLowerCase() : rejected ? http!.status === 409 ? 'conflict' : 'error' : 'unknown', result: null });
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
