import { adminWorkspace } from './adminWorkspace';
import type { AdminGuard } from './adminTransport';
import type { ConversionBatch, ConversionErrorCode, ConversionStore, ConversionTask } from './conversionStore';
import type { ConversionProgress } from './conversionRunner';

const etagPattern = /^"[\x21\x23-\x7E]{1,200}"$/;
type Check = (guard: AdminGuard, signal?: AbortSignal, requireFeature?: boolean) => void;
type Api = typeof import('./conversionApi').conversionApi;
type Failure = (code: ConversionErrorCode) => never;

/** Pins every private range to the captured administrator, exact same-origin source and strong validator. */
async function privateResponse(task: ConversionTask, guard: AdminGuard, signal: AbortSignal, head: boolean,
  fetcher: typeof fetch, check: Check, fail: Failure, start = 0, end = 0) {
  check(guard, signal); if (task.source.kind !== 'remote') fail('conversion_state_invalid');
  const path = task.source.track.mediaUrl;
  if (path !== `/api/admin/v1/catalog/audioTrack/${task.source.track.id}/media`) fail('conversion_state_invalid');
  const headers = new Headers({ 'X-Finitude-Account-Viewer': guard.viewerId, 'Accept-Encoding': 'identity' });
  if (!head) { headers.set('Range', `bytes=${start}-${end}`); headers.set('If-Match', task.source.etag!); headers.set('If-Range', task.source.etag!); }
  const response = await fetcher(path, { method: head ? 'HEAD' : 'GET', headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal });
  check(guard, signal);
  if ([401, 403].includes(response.status)) { adminWorkspace.reset(); fail('conversion_permission_changed'); }
  if (response.headers.get('X-Finitude-Account-Viewer') !== guard.viewerId) fail('conversion_permission_changed');
  const encoding = response.headers.get('Content-Encoding');
  const mime = response.headers.get('Content-Type')?.split(';')[0].toLowerCase();
  if (response.status !== (head ? 200 : 206) || encoding && encoding !== 'identity'
    || !mime || !mime.startsWith('audio/') && mime !== 'application/octet-stream') fail('conversion_source_changed');
  return response;
}

/** Keeps committed source chunks across interruption; only verified complete bytes become an encoding source. */
export async function downloadConversionSource(input: ConversionTask, batch: ConversionBatch, guard: AdminGuard, signal: AbortSignal,
  progress: ((event: ConversionProgress) => void) | undefined, store: ConversionStore, api: Api, fetcher: typeof fetch, check: Check, fail: Failure, maximumBytes: number): Promise<File> {
  const note = (task: ConversionTask, patch: Parameters<ConversionStore['updateTask']>[3]) => store.updateTask(task.ownerId, task.batchId, task.id, patch, guard);
  let task = input; check(guard, signal);
  if (task.source.complete) return store.getSourceFile(task);
  if (task.source.kind !== 'remote') fail('conversion_source_incomplete');
  const fresh = await api.source('tracks', task.source.track.id, guard, signal); check(guard, signal);
  if (fresh.tracks.length !== 1 || JSON.stringify(fresh.tracks[0]) !== JSON.stringify(task.source.track)
    || JSON.stringify(fresh.album) !== JSON.stringify(batch.album)) fail('conversion_source_changed');
  const head = await privateResponse(task, guard, signal, true, fetcher, check, fail), tag = head.headers.get('ETag'), rawLength = head.headers.get('Content-Length');
  if (!tag || !etagPattern.test(tag) || !rawLength || !/^[1-9]\d{0,9}$/.test(rawLength) || head.headers.get('Content-Range') !== null
    || head.headers.get('Accept-Ranges')?.toLowerCase() !== 'bytes') fail('conversion_source_invalid');
  const total = Number(rawLength);
  if (total > maximumBytes) fail('conversion_source_unsupported');
  if (task.source.etag && (task.source.etag !== tag || task.source.byteLength !== total)) fail('conversion_source_changed');
  await store.reserveBytes(task.ownerId, total * 2, guard); check(guard, signal);
  // Persist the pin before any bytes can appear below its app-owned path.
  task = await note(task, { status: 'fetching', error: null, source: { ...task.source, etag: tag, byteLength: total } });
  const handle = await store.sourceHandle(task, true); let file = await handle.getFile(), offset = file.size;
  if (offset > total || task.source.kind !== 'remote' || task.source.downloadedBytes > offset) fail('conversion_source_corrupt');
  while (offset < total) {
    check(guard, signal); const end = Math.min(total - 1, offset + 1024 * 1024 - 1);
    const response = await privateResponse(task, guard, signal, false, fetcher, check, fail, offset, end);
    if (response.headers.get('ETag') !== tag || response.headers.get('Content-Range') !== `bytes ${offset}-${end}/${total}`
      || response.headers.get('Content-Length') !== String(end - offset + 1)) fail('conversion_source_changed');
    const reader = response.body?.getReader(); if (!reader) fail('conversion_source_incomplete');
    const chunks: Uint8Array<ArrayBuffer>[] = []; let received = 0;
    try { while (true) { check(guard, signal); const value = await reader.read(); check(guard, signal); if (value.done) break;
      received += value.value.byteLength; if (received > end - offset + 1) fail('conversion_source_invalid'); chunks.push(new Uint8Array(value.value)); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (received !== end - offset + 1) fail('conversion_source_incomplete');
    const output = await handle.createWritable({ keepExistingData: true });
    try { check(guard, signal); await output.seek(offset); for (const chunk of chunks) { check(guard, signal); await output.write(chunk); }
      check(guard, signal); await output.close(); }
    catch (error) { await output.abort().catch(() => undefined); throw error; }
    offset += received; file = await handle.getFile(); if (file.size !== offset) fail('conversion_source_incomplete');
    if (task.source.kind !== 'remote') fail('conversion_state_invalid');
    task = await note(task, { source: { ...task.source, downloadedBytes: offset } });
    progress?.({ taskId: task.id, stage: 'fetching', progress: offset / total });
  }
  const { hashConversionFile } = await import('./conversionSourceValidation');
  const digest = await hashConversionFile(file, () => check(guard, signal)); check(guard, signal);
  if (task.source.kind !== 'remote') fail('conversion_state_invalid');
  task = await note(task, { source: { ...task.source, sha256: digest, complete: true, downloadedBytes: total } });
  return store.getSourceFile(task);
}
