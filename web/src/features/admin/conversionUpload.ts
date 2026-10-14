import type { AdminGuard } from './adminTransport';
import type { ConversionBatch, ConversionLocalError, ConversionStore, ConversionTask } from './conversionStore';
import type { ConversionReceipt } from './conversionApi';

export interface ConversionUploadDependencies {
  store: ConversionStore;
  getApi: () => Promise<typeof import('./conversionApi').conversionApi>;
  check: (guard: AdminGuard, signal?: AbortSignal, requireFeature?: boolean) => void;
  note: (task: ConversionTask, patch: Parameters<ConversionStore['updateTask']>[3], guard: AdminGuard) => Promise<ConversionTask>;
  receipt: (task: ConversionTask, received: ConversionReceipt, guard: AdminGuard) => Promise<ConversionTask>;
  ErrorClass: typeof ConversionLocalError;
  isNotFound: (error: unknown) => boolean;
  current: (guard: AdminGuard) => boolean;
}

const freezeStamp = (task: ConversionTask) => JSON.stringify({ source: task.source, result: task.result, intent: task.intent });

/** Runs inside the runner's owner lease and never rebases the administrator's approved source or output. */
export async function uploadConversionTasks(frozen: ConversionBatch, ids: string[], approved: ConversionTask[],
  guard: AdminGuard, signal: AbortSignal, dependencies: ConversionUploadDependencies): Promise<ConversionBatch> {
  const { store, getApi, check, note, receipt, ErrorClass, isNotFound, current: currentGuard } = dependencies;
  const batchId = frozen.id, current = await store.get(guard.viewerId, batchId, guard);
  for (const id of ids) {
    const before = approved.find(task => task.id === id)!, observed = current.tasks.find(task => task.id === id);
    if (!observed || freezeStamp(observed) !== freezeStamp(before)) throw new ErrorClass('conversion_source_changed');
  }
  for (const id of ids) {
    check(guard, signal, false); let task = (await store.get(guard.viewerId, batchId, guard)).tasks.find(item => item.id === id)!;
    if (task.source.kind !== 'remote' || !task.result || !task.source.complete || !task.source.etag || !task.source.byteLength) throw new ErrorClass('conversion_state_invalid');
    try {
      if (!task.intent) {
        check(guard, signal, true); const file = await store.getOutputFile(task), album = current.album;
        task = await note(task, { intent: { operationId: crypto.randomUUID(), expectedRevision: task.source.track.revision,
          sourceRevision: task.source.track.sourceRevision, sourceEtag: task.source.etag, sourceByteLength: task.source.byteLength,
          album: album ? { id: album.id, revision: album.revision, membershipRevision: album.membershipRevision } : null,
          output: { sha256: task.result.outputSha256, byteLength: task.result.outputBytes, filename: file.name, preset: 'mp3-320' } } }, guard);
      }
      const trackId = task.source.kind === 'remote' ? task.source.track.id : '';
      let remote: ConversionReceipt;
      try { remote = (await (await getApi()).read(trackId, task.intent!.operationId, guard, signal)).operation; }
      catch (error) {
        if (!isNotFound(error)) throw error;
        check(guard, signal, true); remote = (await (await getApi()).prepare(trackId, task.intent!, guard, signal)).operation;
      }
      check(guard, signal, false); task = await receipt(task, remote, guard);
      let reconciledMissing = false;
      if (remote.cleanupPending || !remote.ready && remote.status !== 'awaitingUpload') {
        remote = (await (await getApi()).reconcile(trackId, task.intent!.operationId, guard, signal)).operation;
        check(guard, signal, false); task = await receipt(task, remote, guard);
        reconciledMissing = !remote.ready && remote.status === 'needsAttention' && ['unknown', 'failed'].includes(remote.upload) && remote.issue === 'ADMIN_CONVERSION_UPLOAD_UNCONFIRMED';
      }
      if (!remote.ready && (remote.status === 'awaitingUpload' && ['notStarted', 'failed'].includes(remote.upload) || reconciledMissing)) {
        check(guard, signal, true); const file = await store.getOutputFile(task); check(guard, signal, true); task = await note(task, { status: 'uploading', error: null }, guard);
        remote = (await (await getApi()).upload(trackId, task.intent!.operationId, file, guard, signal)).operation;
        check(guard, signal, false); task = await receipt(task, remote, guard);
      }
      if (remote.ready && remote.upload === 'ready' && remote.publication === 'ready') {
        await store.cleanupConfirmed(task, { ready: true, trackId, sha256: remote.output.sha256, byteLength: remote.output.byteLength });
      } else await note(task, { status: 'needsAttention', error: 'conversion_upload_unknown' }, guard);
    } catch (error) {
      if (currentGuard(guard)) await note(task, { status: signal.aborted ? 'paused' : 'needsAttention', error: error instanceof ErrorClass ? error.code : 'conversion_upload_unknown' }, guard);
      if (signal.aborted || !currentGuard(guard)) throw error;
    }
  }
  return store.get(guard.viewerId, batchId, guard);
}
