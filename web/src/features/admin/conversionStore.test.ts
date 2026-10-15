import { advanceAccountEpoch } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { createConversionStore, conversionBatchSchema, conversionOutputRelativePath, ConversionLocalError } from './conversionStore';
import { authorize, owner, ownerB, installFiles, file, manifest, memoryPersistence, encoding, locks } from './conversionPersistence.testSupport';

beforeEach(() => { installFiles(); vi.stubGlobal('navigator', { locks: locks() }); authorize(); });
afterEach(() => { vi.unstubAllGlobals(); adminWorkspace.reset(); });

/** Covers both source admission paths without substituting their storage or authorization checks. */
const captureBatch = (store: ReturnType<typeof createConversionStore>, kind: 'local' | 'existing') => kind === 'local'
  ? store.createLocal(owner, [file()], 'Lorem') : store.createExisting(owner, manifest());

test('local selected bytes and full identity survive recreation without source recopy', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), selected = file();
  const batch = await store.createLocal(owner, [selected], 'Lorem');
  expect(batch.tasks[0].source.complete).toBe(true);
  const restored = createConversionStore(memory.persistence);
  expect(await restored.createLocal(owner, [selected], 'Lorem')).toMatchObject({ id: batch.id, tasks: [{ id: batch.tasks[0].id }] });
  const changed = await restored.createLocal(owner, [file([9, 9, 9, ...Array(61).fill(8)])], 'Lorem');
  expect(changed.id).not.toBe(batch.id);
});
test('decomposed source names normalize task metadata and output while reselect remains SHA-bound', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), selected = file(undefined, 'Pre\u0301lude.wav');
  Object.defineProperty(selected, 'webkitRelativePath', { value: 'A\u0301lbum/Pre\u0301lude.wav' });
  const batch = await store.createLocal(owner, [selected], 'Lorem'), task = batch.tasks[0];
  expect(selected.name).toBe('Pre\u0301lude.wav'); expect(selected.webkitRelativePath).toBe('A\u0301lbum/Pre\u0301lude.wav');
  expect(task).toMatchObject({ title: 'Prélude.wav', filename: 'Prélude.wav', relativePath: 'Álbum/Prélude.wav' });
  const canonical = file(undefined, 'Prélude.wav'); Object.defineProperty(canonical, 'webkitRelativePath', { value: 'Álbum/Prélude.wav' });
  expect((await store.createLocal(owner, [canonical], 'Lorem')).id).toBe(batch.id);
  const output = file([9, 8, 7, 6], 'Prélude.mp3'); memory.files.set(memory.fileKey(owner, task.id, 'output'), new Uint8Array(await output.arrayBuffer()));
  const complete = await store.updateTask(owner, batch.id, task.id, { result: await encoding(selected, output), status: 'complete' });
  expect((await store.getOutputFile(complete)).name).toBe('Prélude.mp3');
  const different = file(Array(64).fill(9), 'Pre\u0301lude.wav'); Object.defineProperty(different, 'webkitRelativePath', { value: selected.webkitRelativePath });
  expect((await store.createLocal(owner, [different], 'Lorem')).id).not.toBe(batch.id);
  const existing = manifest(); existing.tracks[0].originalFileName = selected.name;
  const remote = (await store.createExisting(owner, existing)).tasks[0]; expect(remote.filename).toBe('Prélude.wav');
  expect(remote.source.kind === 'remote' && remote.source.track.originalFileName).toBe(selected.name);
  await expect(store.createLocal(owner, [selected, canonical], 'Collision')).rejects.toThrow();
});
test('failed copy keeps its expected hash and reselected identical source repairs the same job', async () => {
  const memory = memoryPersistence(); memory.fault.close = 1; const store = createConversionStore(memory.persistence);
  await expect(store.createLocal(owner, [file()], 'Lorem')).rejects.toThrow();
  const first = (await store.list(owner))[0]; expect(first.tasks[0].source.complete).toBe(false);
  memory.fault.close = 0;
  const repaired = await createConversionStore(memory.persistence).createLocal(owner, [file()], 'Lorem');
  expect(repaired.id).toBe(first.id); expect(repaired.tasks[0].id).toBe(first.tasks[0].id); expect(repaired.tasks[0].source.complete).toBe(true);
});
test('different files with the same output path, oversized selection and excess members fail before persistence', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence);
  await expect(store.createLocal(owner, [file(undefined, 'Lorem.wav'), file(undefined, 'Lorem.flac')], 'Lorem')).rejects.toThrow();
  await expect(store.createLocal(owner, Array(101).fill(file()), 'Lorem')).rejects.toThrow();
  expect(memory.batches.size).toBe(0);
});

test.each([
  ['Track', 'Track.wav'],
  ['a'.repeat(251) + 'X.x', 'a'.repeat(251) + 'Y.x']
])('actual derived MP3 name collisions fail before writing sources (%s, %s)', async (left, right) => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence);
  await expect(store.createLocal(owner, [file(undefined, left), file(undefined, right)], 'Lorem')).rejects.toMatchObject({ code: 'conversion_source_invalid' });
  expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
});

test('output names preserve Unicode scalar values at the filename limit', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), selected = file(undefined, 'a'.repeat(250) + '\u{1F3B5}.x');
  const batch = await store.createLocal(owner, [selected], 'Lorem'), task = batch.tasks[0], output = file([9, 8, 7, 6], 'Output.mp3');
  memory.files.set(memory.fileKey(owner, task.id, 'output'), new Uint8Array(await output.arrayBuffer()));
  const complete = await store.updateTask(owner, batch.id, task.id, { result: await encoding(selected, output), status: 'complete' });
  expect((await store.getOutputFile(complete)).name).toBe('a'.repeat(250) + '.mp3');
  expect(conversionOutputRelativePath(complete)).toBe('a'.repeat(250) + '.mp3');
  expect(selected.name).toBe('a'.repeat(250) + '\u{1F3B5}.x');
});

test('an output path beyond the import context limit fails before any source is persisted', async () => {
  const memory = memoryPersistence(), selected = file(undefined, 'a'.repeat(251));
  Object.defineProperty(selected, 'webkitRelativePath', { value: [...Array(3).fill('d'.repeat(255)), 'abcd', selected.name].join('/') });
  expect(selected.webkitRelativePath.length).toBe(1024);
  await expect(createConversionStore(memory.persistence).createLocal(owner, [selected], 'Lorem')).rejects.toMatchObject({ code: 'conversion_source_invalid' });
  expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
});

test.each(['copy', 'read'] as const)('source %s digest stops at its next chunk after authorization loss', async action => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), selected = file(Array(128 * 1024).fill(1));
  const batch = action === 'read' ? await store.createLocal(owner, [selected], 'Lorem') : null;
  const original = memory.persistence.file; let reads = 0;
  memory.persistence.file = async (...args) => {
    const handle = await original(...args);
    return { ...handle, getFile: async () => {
      const stored = await handle.getFile(), slice = stored.slice.bind(stored);
      Object.defineProperty(stored, 'slice', { value: (...sliceArgs: Parameters<File['slice']>) => {
        if (++reads === 1) advanceAccountEpoch();
        return slice(...sliceArgs);
      } });
      return stored;
    } };
  };
  await expect(action === 'read' ? store.getSourceFile(batch!.tasks[0]) : store.createLocal(owner, [selected], 'Lorem')).rejects.toMatchObject({ code: 'conversion_permission_changed' });
  expect(reads).toBe(1);
  authorize();
  if (action === 'copy') expect((await store.list(owner))[0].tasks[0].source.complete).toBe(false);
  expect(memory.files.has(memory.fileKey(owner, (await store.list(owner))[0].tasks[0].id, 'source'))).toBe(true);
});
test('quota exhaustion and a failed manifest commit never write untraceable source bytes', async () => {
  const memory = memoryPersistence(); memory.persistence.estimate = async () => ({ usage: 10, quota: 11 });
  await expect(createConversionStore(memory.persistence).createLocal(owner, [file()], 'Lorem')).rejects.toMatchObject({ code: 'conversion_storage_full' });
  expect(memory.files.size).toBe(0);
  memory.persistence.estimate = async () => ({ quota: 1024 ** 4, usage: 0 }); memory.fault.commit = true;
  await expect(createConversionStore(memory.persistence).createLocal(owner, [file()], 'Lorem')).rejects.toThrow(); expect(memory.files.size).toBe(0);
});

for (const kind of ['local', 'existing'] as const) {
  test.each(['pending', 'denied', 'rejected', 'thrown'] as const)(`${kind} capture continues when eviction protection is %s`, async outcome => {
    const memory = memoryPersistence();
    const persist = vi.fn((): Promise<boolean> => {
      if (outcome === 'pending') return new Promise<boolean>(() => undefined);
      if (outcome === 'denied') return Promise.resolve(false);
      if (outcome === 'rejected') return Promise.reject(new DOMException('Synthetic refusal', 'NotAllowedError'));
      throw new DOMException('Synthetic unavailable permission request', 'InvalidStateError');
    });
    memory.persistence.persist = persist;
    const store = createConversionStore(memory.persistence), batch = await captureBatch(store, kind);
    expect(persist).toHaveBeenCalledOnce();
    expect(batch.tasks).toHaveLength(1);
    expect(batch.tasks[0]).toMatchObject({ status: 'queued', source: { kind: kind === 'local' ? 'local' : 'remote', complete: kind === 'local' } });
    expect(await store.get(owner, batch.id)).toEqual(batch);
    expect(memory.batches.size).toBe(1); expect(memory.files.size).toBe(kind === 'local' ? 1 : 0);
  });

  test.each(['granted', 'rejected'] as const)(`${kind} late persistence permission %s cannot write after an account transition`, async outcome => {
    const memory = memoryPersistence();
    let grant!: (value: boolean) => void, reject!: (error: Error) => void;
    memory.persistence.persist = () => new Promise<boolean>((resolve, refuse) => { grant = resolve; reject = refuse; });
    const store = createConversionStore(memory.persistence); await captureBatch(store, kind);
    const batches = structuredClone([...memory.batches]), files = [...memory.files].map(([id, bytes]) => [id, Array.from(bytes)]);
    const create = vi.spyOn(memory.persistence, 'create'), mutate = vi.spyOn(memory.persistence, 'mutate'), openFile = vi.spyOn(memory.persistence, 'file');
    authorize(ownerB);
    if (outcome === 'granted') grant(true); else reject(new DOMException('Synthetic delayed refusal', 'NotAllowedError'));
    await Promise.resolve(); await Promise.resolve();
    expect(create).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
    expect([...memory.batches]).toEqual(batches); expect([...memory.files].map(([id, bytes]) => [id, Array.from(bytes)])).toEqual(files);
    await expect(store.list(owner)).rejects.toMatchObject({ code: 'conversion_permission_changed' });
    expect(await store.list(ownerB)).toEqual([]);
  });

  test(`${kind} pending persistence permission cannot bypass the quota admission check`, async () => {
    const memory = memoryPersistence();
    memory.persistence.persist = () => new Promise<boolean>(() => undefined);
    const estimate = vi.fn(async () => ({ usage: 10, quota: 11 })); memory.persistence.estimate = estimate;
    await expect(captureBatch(createConversionStore(memory.persistence), kind)).rejects.toMatchObject({ code: 'conversion_storage_full' });
    expect(estimate).toHaveBeenCalledOnce(); expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
  });

  test(`${kind} authorization loss during the permission request prevents task admission`, async () => {
    const memory = memoryPersistence();
    memory.persistence.persist = () => { advanceAccountEpoch(); return new Promise<boolean>(() => undefined); };
    const estimate = vi.fn(memory.persistence.estimate); memory.persistence.estimate = estimate;
    await expect(captureBatch(createConversionStore(memory.persistence), kind)).rejects.toMatchObject({ code: 'conversion_permission_changed' });
    expect(estimate).not.toHaveBeenCalled(); expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
  });

  test(`${kind} authorization loss while estimating quota prevents task admission`, async () => {
    const memory = memoryPersistence();
    memory.persistence.persist = () => new Promise<boolean>(() => undefined);
    memory.persistence.estimate = async () => { advanceAccountEpoch(); return { usage: 0, quota: 1024 ** 4 }; };
    await expect(captureBatch(createConversionStore(memory.persistence), kind)).rejects.toMatchObject({ code: 'conversion_permission_changed' });
    expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
  });
}

test('an empty Album preview never allocates a conversion job or requests storage', async () => {
  const memory = memoryPersistence(), list = vi.fn(memory.persistence.list), estimate = vi.fn(memory.persistence.estimate), persist = vi.fn(memory.persistence.persist);
  memory.persistence.list = list; memory.persistence.estimate = estimate; memory.persistence.persist = persist;
  await expect(createConversionStore(memory.persistence).createExisting(owner, manifest(0))).rejects.toMatchObject({ code: 'conversion_source_invalid' });
  expect(list).not.toHaveBeenCalled(); expect(estimate).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(memory.batches.size).toBe(0); expect(memory.files.size).toBe(0);
});
test('owner/view/account fences prevent private enumeration and late copy completion', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence); await store.createLocal(owner, [file()], 'Lorem');
  authorize(ownerB); await expect(store.list(owner)).rejects.toThrow(); expect(await store.list(ownerB)).toEqual([]);
  authorize(); memory.fault.onWrite = () => advanceAccountEpoch();
  await expect(store.createLocal(owner, [file([1, 2, 3])], 'Other')).rejects.toThrow();
  authorize(); const incomplete = (await store.list(owner)).find(batch => batch.rootLabel === 'Other')!; expect(incomplete.tasks[0].source.complete).toBe(false);
  adminWorkspace.select('user'); await expect(store.get(owner, incomplete.id)).rejects.toThrow();
});
test('exact existing source/profile reuses its queue and schema rejects future/foreign/extra data', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createExisting(owner, manifest(2));
  expect((await store.createExisting(owner, manifest(2))).id).toBe(batch.id);
  expect(batch.tasks.map(task => task.source.kind === 'remote' && task.source.track.id)).toEqual(manifest(2).tracks.map(track => track.id));
  memory.batches.set(memory.key(owner, batch.id), { ...batch, schemaVersion: 2 }); await expect(store.list(owner)).rejects.toMatchObject({ code: 'conversion_state_invalid' });
  expect(conversionBatchSchema.safeParse({ ...batch, cookie: 'never-persist' }).success).toBe(false);
});

test.each(['rate', 'sourceDuration', 'outputFrames', 'outputDuration'] as const)('reopening rejects a persisted result with inconsistent %s', async mismatch => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), source = file(), output = file([3, 4, 5, 6], 'Lorem.mp3');
  const batch = await store.createLocal(owner, [source], 'Lorem'), result = await encoding(source, output);
  await store.updateTask(owner, batch.id, batch.tasks[0].id, { result, status: 'complete' });
  const saved = structuredClone(await store.get(owner, batch.id)), invalid = saved.tasks[0].result!;
  if (mismatch === 'rate') { invalid.sourceSampleRate = 96000; invalid.sourceFrames = 96000; invalid.resampled = true; }
  if (mismatch === 'sourceDuration') invalid.sourceDurationSeconds += 0.05;
  if (mismatch === 'outputFrames') invalid.outputFrames = 1;
  if (mismatch === 'outputDuration') invalid.durationSeconds = 60;
  memory.batches.set(memory.key(owner, batch.id), saved);
  await expect(createConversionStore(memory.persistence).get(owner, batch.id)).rejects.toMatchObject({ code: 'conversion_state_invalid' });
});
test('live origin-wide lease reports active state while closed jobs rehydrate paused', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), guard = adminWorkspace.capture(), batch = await store.createExisting(owner, manifest());
  await store.updateTask(owner, batch.id, batch.tasks[0].id, { status: 'fetching' }, guard);
  expect((await store.list(owner))[0].tasks[0].status).toBe('paused');
  await navigator.locks.request(`finitude-conversion-executor-${owner}`, async () => { expect((await store.list(owner))[0].tasks[0].status).toBe('fetching'); });
});
test('import intent freezes membership and cannot silently mint a second operation after a lost response', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file()], 'Lorem');
  const task = batch.tasks[0], slotId = crypto.randomUUID(), intent = { operationId: crypto.randomUUID(), projectId: null,
    manifest: { rootLabel: 'Lorem', files: [{ slotId, filename: 'Lorem.mp3', relativePath: 'Lorem.mp3', byteLength: 8 }] }, slots: [{ taskId: task.id, slotId }] };
  await store.updateBatch(owner, batch.id, { importIntent: intent });
  await expect(store.updateBatch(owner, batch.id, { importIntent: { ...intent, operationId: crypto.randomUUID() } })).rejects.toThrow();
  await expect(store.updateBatch(owner, batch.id, { importIntent: undefined })).rejects.toThrow();
  expect((await store.get(owner, batch.id)).importIntent?.operationId).toBe(intent.operationId);
});
test('only exact publication proof removes MP3; original source and failed cleanup evidence remain', async () => {
  const memory = memoryPersistence(), store = createConversionStore(memory.persistence), batch = await store.createLocal(owner, [file()], 'Lorem');
  const task = batch.tasks[0], out = file([3, 4, 5, 6], 'Lorem.mp3'), result = await encoding(file(), out);
  memory.files.set(memory.fileKey(owner, task.id, 'output'), new Uint8Array(await out.arrayBuffer()));
  await store.updateTask(owner, batch.id, task.id, { result, status: 'complete' });
  const slotId = crypto.randomUUID(); await store.updateBatch(owner, batch.id, { importIntent: { operationId: crypto.randomUUID(), projectId: '333333333333333333333333',
    manifest: { rootLabel: 'Lorem', files: [{ slotId, filename: 'Lorem.mp3', relativePath: 'Lorem.mp3', byteLength: 4 }] }, slots: [{ taskId: task.id, slotId }] } });
  const proof = { ready: true as const, trackId: '444444444444444444444444', sha256: result.outputSha256, byteLength: result.outputBytes };
  await expect(store.cleanupConfirmed(task, { ...proof, byteLength: 3 })).rejects.toThrow();
  memory.fault.remove = true; await expect(store.cleanupConfirmed(task, proof)).rejects.toThrow(); expect((await store.get(owner, batch.id)).tasks[0].cacheRemoved).toBe(false);
  memory.fault.remove = false; await store.cleanupConfirmed(task, proof);
  expect(memory.files.has(memory.fileKey(owner, task.id, 'source'))).toBe(true); expect(memory.files.has(memory.fileKey(owner, task.id, 'output'))).toBe(false);
  expect((await store.get(owner, batch.id)).tasks[0]).toMatchObject({ status: 'uploaded', cacheRemoved: true });
});
test('unsupported state never permits identity mutation or arbitrary cleanup', async () => {
  const store = createConversionStore(memoryPersistence().persistence), batch = await store.createLocal(owner, [file()], 'Lorem');
  await expect(store.updateTask(owner, batch.id, batch.tasks[0].id, { ownerId: ownerB } as never)).rejects.toBeInstanceOf(ConversionLocalError);
  await expect(store.cleanupConfirmed(batch.tasks[0], { ready: true, trackId: ownerB, sha256: 'f'.repeat(64), byteLength: 1 })).rejects.toThrow();
});
