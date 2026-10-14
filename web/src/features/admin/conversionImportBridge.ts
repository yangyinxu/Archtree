import { adminWorkspace } from './adminWorkspace';
import { adminRequest } from './adminTransport';
import { conversionApi } from './conversionApi';
import { namingManifest } from './manifest';
import { conversionExecutorLock, conversionOutputRelativePath, conversionStore, type ConversionBatch } from './conversionStore';
import type { AdminGuard } from './adminTransport';

/** A private draft is idempotently created from the fixed, already encoded Album selection. */
export async function createConversionImport(batch: ConversionBatch, guard: AdminGuard) {
  return navigator.locks.request(conversionExecutorLock(guard.viewerId), { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock || !adminWorkspace.current(guard)) throw new Error('CONVERSION_BUSY');
    // Always recover persisted intent under the shared owner lock; a stale UI cannot mint a second draft.
    const current = await conversionStore.get(guard.viewerId, batch.id, guard);
    return createLockedImport(current, guard);
  });
}

async function createLockedImport(batch: ConversionBatch, guard: AdminGuard) {
  const { responseSchema } = await import('./adminApi');
  if (batch.kind !== 'local' || !batch.tasks.length || batch.tasks.some(task => !task.result || task.cacheRemoved)) throw new Error('CONVERSION_OUTPUT_REQUIRED');
  let intent = batch.importIntent;
  if (!intent) {
    const files = await Promise.all(batch.tasks.map(task => conversionStore.getOutputFile(task)));
    const manifest = namingManifest(files.map((file, index) => ({ name: file.name, size: file.size,
      webkitRelativePath: conversionOutputRelativePath(batch.tasks[index]) })));
    manifest.rootLabel = batch.rootLabel;
    intent = { operationId: crypto.randomUUID(), manifest, projectId: null,
      slots: manifest.files.map((file, index) => ({ taskId: batch.tasks[index].id, slotId: file.slotId })) };
    // A lost response can only replay this same manifest and operation identifier.
    await conversionStore.updateBatch(batch.ownerId, batch.id, { importIntent: intent }, guard);
  }
  const { item, receipt } = await adminRequest('', responseSchema, { method: 'POST',
    body: JSON.stringify({ operationId: intent.operationId, manifest: intent.manifest }) }, guard);
  if (receipt?.operationId !== intent.operationId || receipt.kind !== 'create' || !item.startedByMe
    || JSON.stringify(item.manifest) !== JSON.stringify(intent.manifest)
    || intent.slots.some(slot => !item.manifest.files.some(file => file.slotId === slot.slotId))) throw new Error('CONVERSION_IMPORT_UNCONFIRMED');
  await conversionStore.updateBatch(batch.ownerId, batch.id, { importIntent: { ...intent, projectId: item.id } }, guard);
  await hydrateConversionImport(item.id, guard);
  return item.id;
}

/** Restores completed MP3 file choices after a reload without re-encoding or exposing another account. */
export async function hydrateConversionImport(projectId: string, guard: AdminGuard) {
  const batches = await conversionStore.list(guard.viewerId);
  const matches = batches.filter(batch => batch.importIntent?.projectId === projectId);
  const files: Record<string, File> = {};
  for (const batch of matches) for (const slot of batch.importIntent!.slots) {
    const task = batch.tasks.find(task => task.id === slot.taskId);
    if (!task?.result || task.cacheRemoved) continue;
    try { files[slot.slotId] = await conversionStore.getOutputFile(task); } catch { /* Missing cache stays visible as a manual file choice. */ }
  }
  if (!adminWorkspace.current(guard)) throw new DOMException('View changed', 'AbortError');
  adminWorkspace.retain(`files:${projectId}`, { ...adminWorkspace.buffer<Record<string, File>>(`files:${projectId}`), ...files }, guard);
}

/** Staged uploads alone are insufficient: exact current publication and S3 proof precede cache deletion. */
export async function cleanConversionImport(batch: ConversionBatch, guard: AdminGuard) {
  return navigator.locks.request(conversionExecutorLock(guard.viewerId), { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock || !adminWorkspace.current(guard)) throw new Error('CONVERSION_BUSY');
    return cleanLockedImport(await conversionStore.get(guard.viewerId, batch.id, guard), guard);
  });
}
async function cleanLockedImport(batch: ConversionBatch, guard: AdminGuard) {
  const intent = batch.importIntent;
  if (!intent?.projectId) return;
  const remaining = intent.slots.filter(slot => batch.tasks.some(task => task.id === slot.taskId && task.result && !task.cacheRemoved));
  if (!remaining.length) return;
  const proof = await conversionApi.importProof(intent.projectId, guard, undefined, remaining.map(slot => slot.slotId));
  if (!adminWorkspace.current(guard)) throw new DOMException('View changed', 'AbortError');
  if (proof.projectId !== intent.projectId || !proof.publicationOperationId) return;
  for (const slot of remaining) {
    const task = batch.tasks.find(task => task.id === slot.taskId);
    if (!task?.result || task.cacheRemoved) continue;
    const exact = proof.ready.find(item => item.slotId === slot.slotId && item.sha256 === task.result!.outputSha256 && item.byteLength === task.result!.outputBytes);
    if (exact) {
      if (!adminWorkspace.current(guard)) throw new DOMException('View changed', 'AbortError');
      await conversionStore.cleanupConfirmed(task, { ready: true, trackId: exact.trackId, sha256: exact.sha256, byteLength: exact.byteLength });
    }
  }
}

/** Final publication readback also finishes linked local cache lifecycle after navigation. */
export async function finalizeConversionImport(projectId: string, guard: AdminGuard) {
  const batches = await conversionStore.list(guard.viewerId);
  for (const batch of batches) if (batch.importIntent?.projectId === projectId) await cleanConversionImport(batch, guard);
}
