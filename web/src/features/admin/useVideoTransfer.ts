import { useState } from 'react';
import { ApiError, type UploadProgress } from '../../api/client';
import { adminWorkspace } from './adminWorkspace';
import { adminEndpointRequest } from './adminTransport';
import { uploadVideoFile, videoPath, videoResponseSchema, type VideoProject } from './videoUploadApi';

interface TransferIntent { kind: 'source' | 'covers'; file: Blob; filename: string; operationId: string; expectedRevision: number }
interface TransferState { running: boolean; intent: TransferIntent | null; progress: UploadProgress | null; error: 'unknown' | 'file' | 'conflict' | 'error' | null }
const idle: TransferState = { running: false, intent: null, progress: null, error: null };

/** Transport loss and server failures can hide an admitted write; definite validation refusals cannot. */
export function videoTransferFailure(error: unknown): Pick<TransferState, 'error'> & { unknown: boolean } {
  if (!(error instanceof ApiError) || error.kind !== 'http' || (error.status ?? 0) >= 500) return { error: 'unknown', unknown: true };
  if (/UNKNOWN|BUSY|RECONCIL(?:E|IATION)_REQUIRED|SOURCE_EXISTS/.test(error.code ?? '')) return { error: 'unknown', unknown: true };
  return { error: error.status === 413 || error.status === 400 || error.status === 422 ? 'file' : error.status === 409 ? 'conflict' : 'error', unknown: false };
}

/** Retains exact media bytes in account-fenced memory; reconciliation never starts another transfer. */
export function useVideoTransfer(projectId: string, onResult: (item: VideoProject, kind?: 'source' | 'covers', operationId?: string) => void) {
  const key = `video-transfer:${projectId}`;
  const [state, setState] = useState<TransferState>(() => {
    const kept = adminWorkspace.buffer<TransferState>(key);
    return kept?.intent ? { ...kept, running: false, progress: null, error: 'unknown' } : idle;
  });
  const update = (next: TransferState) => { adminWorkspace.retain(key, next, adminWorkspace.capture()); setState(next); };
  const send = async (intent: TransferIntent) => {
    const guard = adminWorkspace.capture();
    let active = true;
    update({ running: true, intent, progress: { loaded: 0, total: null }, error: null });
    try {
      const result = await uploadVideoFile(projectId, intent.kind, intent.file, intent.filename, intent.operationId, intent.expectedRevision, guard, progress => {
        if (active && adminWorkspace.current(guard)) update({ running: true, intent, progress, error: null });
      });
      if (!adminWorkspace.current(guard)) return;
      update(idle); onResult(result.item, intent.kind, intent.operationId);
    } catch (error) {
      if (!adminWorkspace.current(guard)) return;
      const failure = videoTransferFailure(error);
      update({ running: false, intent: failure.unknown ? intent : null, progress: null, error: failure.error });
    } finally { active = false; }
  };
  return {
    ...state,
    upload(kind: TransferIntent['kind'], file: Blob, filename: string, expectedRevision: number) {
      if (state.running || state.intent || !adminWorkspace.getSnapshot().authorized || navigator.onLine === false) return;
      void send({ kind, file, filename, expectedRevision, operationId: crypto.randomUUID() });
    },
    async reconcile(operationId: string, coverId?: string, coverOperation = false) {
      if (state.running) return;
      const guard = adminWorkspace.capture(); update({ ...state, running: true, progress: null, error: null });
      try {
        const isCover = coverOperation || Boolean(coverId) || state.intent?.kind === 'covers';
        const suffix = coverId ? `/covers/${encodeURIComponent(coverId)}/reconcile` : isCover ? '/covers/reconcile' : '/source/reconcile';
        const result = await adminEndpointRequest(`${videoPath(projectId)}${suffix}`, videoResponseSchema.refine(result => result.item.id === projectId),
          { method: 'POST', body: JSON.stringify({ operationId }) }, guard);
        if (!adminWorkspace.current(guard)) return;
        const unsettled = isCover ? result.item.covers.some(cover => cover.operationId === operationId && cover.state === 'unknown')
          || result.item.ingress.cover?.operationId === operationId && result.item.ingress.cover.state === 'receiving' : ['pending', 'unknown'].includes(result.item.source.status);
        update(unsettled ? { running: false, intent: state.intent, progress: null, error: 'unknown' } : idle);
        onResult(result.item);
      } catch (error) {
        // A request can still be receiving bytes before its object reservation is visible; 404 never proves refusal.
        if (adminWorkspace.current(guard)) update({ running: false, intent: state.intent, progress: null, error: 'unknown' });
      }
    }
  };
}
