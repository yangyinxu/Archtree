import { ApiError } from '../../api/client';
import { adminWorkspace } from './adminWorkspace';
import { conversionApi, type ConversionReceipt } from './conversionApi';
import { createConversionStore, type ConversionTask } from './conversionStore';
import { createConversionRunner } from './conversionRunner';
import { authorize, owner, installFiles, file, manifest, memoryPersistence, encoding, locks } from './conversionPersistence.testSupport';
import { hashConversionFile } from './conversionSourceValidation';
import type { ConversionWorkerRequest } from './conversionWorkerProtocol';

beforeEach(() => { installFiles(); vi.stubGlobal('Headers', new Response().headers.constructor); vi.stubGlobal('navigator', { locks: locks() }); authorize(); });
afterEach(() => { vi.unstubAllGlobals(); adminWorkspace.reset(); });
const worker = (count = vi.fn(), hang = false, outputBytes = [9, 8, 7, 6]) => {
  const value = { onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], terminate: vi.fn(),
    postMessage(request: ConversionWorkerRequest) { count(); if (hang) return;
      void (async () => { const output = file(outputBytes, 'Lorem.mp3'), writer = await request.output.createWritable(); await writer.write(output); await writer.close();
        const result = await encoding(request.source, output); value.onmessage?.call(value as unknown as Worker, { data: { type: 'complete', taskId: request.taskId, result } } as MessageEvent); })();
    } };
  return value as unknown as Worker;
};
const seedRemote = async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest());
  const task = batch.tasks[0], source = file(), output = file([9, 8, 7, 6], 'Lorem.mp3'), result = await encoding(source, output);
  memory.files.set(memory.fileKey(owner, task.id, 'source'), new Uint8Array(await source.arrayBuffer()));
  memory.files.set(memory.fileKey(owner, task.id, 'output'), new Uint8Array(await output.arrayBuffer()));
  if (task.source.kind !== 'remote') throw new Error('fixture');
  const ready = await store.updateTask(owner, batch.id, task.id, { source: { ...task.source, etag: '"lorem"', byteLength: source.size, downloadedBytes: source.size, sha256: result.sourceSha256, complete: true }, result, status: 'complete' });
  return { memory, store, batch, task: ready, source, output, result };
};
const response = (task: ConversionTask, extras: Partial<ConversionReceipt> = {}) => ({ schemaVersion: 1 as const, operation: {
  operationId: task.intent!.operationId, trackId: task.source.kind === 'remote' ? task.source.track.id : '', status: 'awaitingUpload' as const,
  upload: 'notStarted' as const, publication: 'notStarted' as const, ready: false, cleanupPending: false, issue: null,
  output: { sha256: task.result!.outputSha256, byteLength: task.result!.outputBytes, preset: 'mp3-320' as const }, ...extras
} });
const intent = (task: ConversionTask, batch: Awaited<ReturnType<typeof seedRemote>>['batch']) => {
  if (task.source.kind !== 'remote') throw new Error('fixture');
  return { operationId: crypto.randomUUID(), expectedRevision: task.source.track.revision, sourceRevision: task.source.track.sourceRevision,
    sourceEtag: task.source.etag!, sourceByteLength: task.source.byteLength!, album: batch.album ? { id: batch.album.id, revision: batch.album.revision, membershipRevision: batch.album.membershipRevision } : null,
    output: { sha256: task.result!.outputSha256, byteLength: task.result!.outputBytes, preset: 'mp3-320' as const, filename: 'Lorem.mp3' } };
};

test('restart preserves completed MP3 and only encodes remaining fixed Album members', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file(undefined, 'One.wav'), file(undefined, 'Two.wav')], 'Lorem');
  const count = vi.fn(), first = createConversionRunner({ store, worker: () => worker(count) }); await first.run(batch.id, adminWorkspace.capture()); expect(count).toHaveBeenCalledTimes(2);
  await createConversionRunner({ store: createConversionStore(memory.persistence), worker: () => worker(count) }).run(batch.id, adminWorkspace.capture()); expect(count).toHaveBeenCalledTimes(2);
});
test('missing MP3 rebuilds from validated original source without a new source copy', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file()], 'Lorem'), count = vi.fn();
  const runner = createConversionRunner({ store, worker: () => worker(count) }); await runner.run(batch.id, adminWorkspace.capture());
  memory.files.delete(memory.fileKey(owner, batch.tasks[0].id, 'output')); await runner.run(batch.id, adminWorkspace.capture());
  expect(count).toHaveBeenCalledTimes(2); expect((await store.get(owner, batch.id)).tasks[0].status).toBe('complete'); expect(memory.files.has(memory.fileKey(owner, batch.tasks[0].id, 'source'))).toBe(true);
});
test('stop and Admin/User transition terminate a worker and prevent a late completion', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file()], 'Lorem');
  const instance = worker(vi.fn(), true), runner = createConversionRunner({ store, worker: () => instance });
  const pending = runner.run(batch.id, adminWorkspace.capture());
  await vi.waitFor(() => expect((runner.getActiveBatch())).toBe(batch.id)); await vi.waitFor(() => expect((instance.postMessage as unknown)).toBeDefined());
  await vi.waitFor(async () => expect((await store.get(owner, batch.id)).tasks[0].status).toBe('encoding'));
  adminWorkspace.select('user'); await expect(pending).rejects.toThrow(); expect(instance.terminate).toHaveBeenCalled(); authorize();
  expect((await store.list(owner))[0].tasks[0].status).toBe('paused'); expect((await store.get(owner, batch.id)).tasks[0].result).toBeNull();
});
test('origin-wide exclusive lease refuses a second executor before encoding', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file()], 'Lorem'), count = vi.fn();
  const runner = createConversionRunner({ store, worker: () => worker(count) });
  await navigator.locks.request(`finitude-conversion-executor-${owner}`, async () => { await expect(runner.run(batch.id, adminWorkspace.capture())).rejects.toMatchObject({ code: 'conversion_busy' }); });
  expect(count).not.toHaveBeenCalled();
});
test('range transfer validates exact 206/Content-Range and retains durable source bytes', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest()), source = file();
  const fetcher = vi.fn(async (_path: string | URL | Request, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : await source.arrayBuffer(), {
    status: init?.method === 'HEAD' ? 200 : 206, headers: { 'X-Finitude-Account-Viewer': owner, 'Content-Type': 'audio/flac', 'ETag': '"lorem"', 'Content-Length': String(source.size), 'Accept-Ranges': 'bytes',
      ...(init?.method === 'HEAD' ? {} : { 'Content-Range': `bytes 0-${source.size - 1}/${source.size}` }) } }));
  const api = { ...conversionApi, source: vi.fn(async () => manifest()) }, runner = createConversionRunner({ store, api, fetch: fetcher as typeof fetch, worker: () => worker() });
  await runner.run(batch.id, adminWorkspace.capture()); const task = (await store.get(owner, batch.id)).tasks[0];
  expect(task).toMatchObject({ status: 'complete', source: { complete: true, downloadedBytes: source.size, sha256: await hashConversionFile(source) } });
  expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'error', credentials: 'same-origin' }); expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('If-Match')).toBe('"lorem"');
});
test.each([200, 206])('wrong status/range never appends response bytes (%s)', async status => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest());
  const fetcher = vi.fn(async (_path: unknown, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : Uint8Array.from([1, 2, 3]), { status: init?.method === 'HEAD' ? 200 : status,
    headers: { 'X-Finitude-Account-Viewer': owner, 'Content-Type': 'audio/flac', 'Content-Length': '3', 'ETag': '"lorem"', 'Accept-Ranges': 'bytes', ...(init?.method === 'HEAD' ? {} : { 'Content-Range': 'bytes 0-1/3' }) } }));
  const count = vi.fn(), runner = createConversionRunner({ store, api: { ...conversionApi, source: vi.fn(async () => manifest()) }, fetch: fetcher as typeof fetch, worker: () => worker(count) });
  await runner.run(batch.id, adminWorkspace.capture()); expect(count).not.toHaveBeenCalled(); expect((await store.get(owner, batch.id)).tasks[0].status).toBe('needsAttention');
  expect(memory.files.get(memory.fileKey(owner, batch.tasks[0].id, 'source'))?.length).toBe(0);
});
test('frozen confirmation compares the displayed result under the execution lease', async () => {
  const fixture = await seedRemote(), approved = structuredClone(fixture.task), replacement = file([1, 2, 3, 4], 'Other.mp3');
  const updated = await encoding(fixture.source, replacement); fixture.memory.files.set(fixture.memory.fileKey(owner, fixture.task.id, 'output'), new Uint8Array(await replacement.arrayBuffer()));
  await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { result: updated });
  const read = vi.fn(), runner = createConversionRunner({ store: fixture.store, api: { ...conversionApi, read } });
  await expect(runner.upload(fixture.batch.id, adminWorkspace.capture(), [fixture.task.id], [approved])).rejects.toMatchObject({ code: 'conversion_source_changed' }); expect(read).not.toHaveBeenCalled();
});
test('unknown upload retains original intent and explicit retry resends only after reconcile confirms missing', async () => {
  const fixture = await seedRemote(), approved = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  const unknown = response(approved, { status: 'needsAttention', upload: 'unknown', issue: 'ADMIN_CONVERSION_UPLOAD_UNCONFIRMED' });
  const read = vi.fn(async () => unknown), reconcile = vi.fn(async () => unknown), upload = vi.fn(async (_trackId: string, _operationId: string) => response(approved, { status: 'complete', upload: 'ready', publication: 'ready', ready: true }));
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, read, reconcile, upload } }).upload(fixture.batch.id, adminWorkspace.capture(), [approved.id], [approved]);
  expect(reconcile).toHaveBeenCalledTimes(1); expect(upload).toHaveBeenCalledTimes(1); expect(upload.mock.calls[0][1]).toBe(approved.intent!.operationId);
  expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0]).toMatchObject({ cacheRemoved: true, status: 'uploaded', intent: approved.intent });
  expect(fixture.memory.files.has(fixture.memory.fileKey(owner, approved.id, 'source'))).toBe(true);
});
test('active lease or uncertain HEAD never authorizes another upload', async () => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  const read = vi.fn(async () => response(task, { status: 'uploading', upload: 'pending' })), reconcile = vi.fn(async () => { throw new ApiError('Synthetic busy', 'http', 409); }), upload = vi.fn();
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, read, reconcile, upload } }).upload(fixture.batch.id, adminWorkspace.capture(), [task.id]);
  expect(upload).not.toHaveBeenCalled(); expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0].intent).toEqual(task.intent);
});
test('feature disabled still permits original ready receipt cleanup but never prepare/PUT', async () => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  authorize(owner, false);
  const read = vi.fn(async () => response(task, { status: 'complete', upload: 'ready', publication: 'ready', ready: true, cleanupPending: true })),
    reconcile = vi.fn(async () => response(task, { status: 'complete', upload: 'ready', publication: 'ready', ready: true })), prepare = vi.fn(), upload = vi.fn();
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, read, reconcile, prepare, upload } }).upload(fixture.batch.id, adminWorkspace.capture(), [task.id]);
  expect(reconcile).toHaveBeenCalledTimes(1); expect(prepare).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0].cacheRemoved).toBe(true);
});
test('server-confirmed cancellation preserves frozen intent/cache but permits explicit new source capture', async () => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  const cancel = vi.fn(async () => response(task, { status: 'needsAttention', upload: 'failed', issue: 'ADMIN_CONVERSION_CANCELLED' }));
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, cancel } }).cancel(task, adminWorkspace.capture());
  const old = (await fixture.store.get(owner, fixture.batch.id)).tasks[0]; expect(old.intent).toEqual(task.intent); expect(old.cacheRemoved).toBe(false);
  expect((await fixture.store.createExisting(owner, manifest())).id).not.toBe(fixture.batch.id);
});
test('remote completed cache checks current source before describing the task as reusable', async () => {
  const fixture = await seedRemote(), changed = manifest(); changed.tracks[0].sourceRevision = `mr_${'e'.repeat(32)}`;
  const source = vi.fn(async () => changed), count = vi.fn();
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, source }, worker: () => worker(count) }).run(fixture.batch.id, adminWorkspace.capture());
  expect(count).not.toHaveBeenCalled(); expect(source).toHaveBeenCalledTimes(1);
  expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0]).toMatchObject({ status: 'needsAttention', error: 'conversion_source_changed', result: fixture.result });
  expect(fixture.memory.files.has(fixture.memory.fileKey(owner, fixture.task.id, 'output'))).toBe(true);
});
test.each([false, true])('missing frozen output reconciles the original operation before rebuilding and keeps its identity (%s mismatch)', async mismatch => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  fixture.memory.files.delete(fixture.memory.fileKey(owner, task.id, 'output'));
  const source = vi.fn(), read = vi.fn(async () => response(task, { status: 'needsAttention', upload: 'unknown', issue: 'ADMIN_CONVERSION_UPLOAD_UNCONFIRMED' }));
  const reconcile = vi.fn(async () => response(task, { status: 'needsAttention', upload: 'unknown', issue: 'ADMIN_CONVERSION_UPLOAD_UNCONFIRMED' })), count = vi.fn();
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, source, read, reconcile }, worker: () => worker(count, false, mismatch ? [6, 7, 8, 9] : undefined) }).run(fixture.batch.id, adminWorkspace.capture());
  expect(source).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1); expect(reconcile).toHaveBeenCalledTimes(1); expect(count).toHaveBeenCalledTimes(1);
  const recovered = (await fixture.store.get(owner, fixture.batch.id)).tasks[0];
  expect(recovered.intent).toEqual(task.intent); expect(recovered.result).toEqual(task.result); expect(recovered.cacheRemoved).toBe(false);
  expect(recovered.error).toBe(mismatch ? 'conversion_output_invalid' : 'conversion_upload_unknown');
  if (!mismatch) expect((await fixture.store.getOutputFile(recovered)).size).toBe(fixture.output.size);
});
test('ready original operation recovers even with no MP3 cache and never re-encodes', async () => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  fixture.memory.files.delete(fixture.memory.fileKey(owner, task.id, 'output')); const count = vi.fn(), source = vi.fn();
  const read = vi.fn(async () => response(task, { status: 'complete', upload: 'ready', publication: 'ready', ready: true }));
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, source, read }, worker: () => worker(count) }).run(fixture.batch.id, adminWorkspace.capture());
  expect(source).not.toHaveBeenCalled(); expect(count).not.toHaveBeenCalled();
  expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0]).toMatchObject({ status: 'uploaded', cacheRemoved: true, intent: task.intent });
});
test('reconcile storage uncertainty cannot authorize a resend even when GET looked missing', async () => {
  const fixture = await seedRemote(), task = await fixture.store.updateTask(owner, fixture.batch.id, fixture.task.id, { intent: intent(fixture.task, fixture.batch) });
  const read = vi.fn(async () => response(task, { status: 'needsAttention', upload: 'unknown', issue: 'ADMIN_CONVERSION_UPLOAD_UNCONFIRMED' }));
  const reconcile = vi.fn(async () => response(task, { status: 'needsAttention', upload: 'unknown', issue: 'ADMIN_CONVERSION_STORAGE_UNCONFIRMED' })), upload = vi.fn();
  await createConversionRunner({ store: fixture.store, api: { ...conversionApi, read, reconcile, upload } }).upload(fixture.batch.id, adminWorkspace.capture(), [task.id], [task]);
  expect(upload).not.toHaveBeenCalled(); expect((await fixture.store.get(owner, fixture.batch.id)).tasks[0].intent).toEqual(task.intent);
});
test('interrupted transfer resumes only its committed source range and never downloads completed bytes again', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest());
  const source = new File([new Uint8Array(1024 * 1024 + 64)], 'Lorem.flac'), ranges: string[] = [];
  const fetcher = vi.fn(async (_path: unknown, init?: RequestInit) => {
    const head = init?.method === 'HEAD', range = (init?.headers as Headers).get('Range') ?? ''; if (!head) ranges.push(range);
    const parts = /bytes=(\d+)-(\d+)/.exec(range), start = Number(parts?.[1] ?? 0), end = Number(parts?.[2] ?? source.size - 1);
    return new Response(head ? null : await source.slice(start, end + 1).arrayBuffer(), { status: head ? 200 : 206,
      headers: { 'X-Finitude-Account-Viewer': owner, 'Content-Type': 'audio/flac', 'Content-Length': String(head ? source.size : end - start + 1), 'ETag': '"lorem"', 'Accept-Ranges': 'bytes',
        ...(head ? {} : { 'Content-Range': `bytes ${start}-${end}/${source.size}` }) } });
  });
  const api = { ...conversionApi, source: vi.fn(async () => manifest()) }, first = createConversionRunner({ store, api, fetch: fetcher as typeof fetch, worker: () => worker() });
  await expect(first.run(batch.id, adminWorkspace.capture(), event => { if (event.stage === 'fetching') first.stop(); })).rejects.toMatchObject({ code: 'conversion_cancelled' });
  expect((await store.get(owner, batch.id)).tasks[0].source).toMatchObject({ complete: false, downloadedBytes: 1024 * 1024 });
  await createConversionRunner({ store, api, fetch: fetcher as typeof fetch, worker: () => worker() }).run(batch.id, adminWorkspace.capture());
  expect(ranges).toEqual(['bytes=0-1048575', 'bytes=1048576-1048639']); expect((await store.get(owner, batch.id)).tasks[0].source.complete).toBe(true);
});
test.each(['etag', 'viewer'])('resuming a source refuses a changed %s before appending durable bytes', async mismatch => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest()), task = batch.tasks[0];
  if (task.source.kind !== 'remote') throw new Error('fixture');
  const prefix = new Uint8Array([1, 2, 3, 4]); memory.files.set(memory.fileKey(owner, task.id, 'source'), prefix);
  await store.updateTask(owner, batch.id, task.id, { source: { ...task.source, etag: '"lorem"', byteLength: 64, downloadedBytes: 4 } });
  const count = vi.fn(), fetcher = vi.fn(async () => new Response(null, { status: 200,
    headers: { 'X-Finitude-Account-Viewer': mismatch === 'viewer' ? '222222222222222222222222' : owner, 'ETag': mismatch === 'etag' ? '"changed"' : '"lorem"',
      'Content-Length': '64', 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes' } }));
  await createConversionRunner({ store, api: { ...conversionApi, source: vi.fn(async () => manifest()) }, fetch: fetcher as typeof fetch, worker: () => worker(count) }).run(batch.id, adminWorkspace.capture());
  expect(fetcher).toHaveBeenCalledTimes(1); expect(count).not.toHaveBeenCalled(); expect(memory.files.get(memory.fileKey(owner, task.id, 'source'))).toEqual(prefix);
  expect((await store.get(owner, batch.id)).tasks[0]).toMatchObject({ status: 'needsAttention', error: mismatch === 'etag' ? 'conversion_source_changed' : 'conversion_permission_changed' });
});
