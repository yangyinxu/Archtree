import { act, cleanup, renderHook } from '@testing-library/react';
import { captureAccountOperation } from '../../api/accountEpoch';
import type { ImportDetail } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import { detail, json, projectId, slotId, slotTwo, viewer } from './adminFixtures.testSupport';
import { useImportUploadQueue } from './useImportUploadQueue';

// Each engine load waits until the test releases it, failed (as a lost chunk would be) or loaded.
const loads = vi.hoisted(() => ({ pending: [] as Array<(fail: boolean) => void> }));
vi.mock('./importUploadQueue', async importOriginal => {
  if (await new Promise<boolean>(release => { loads.pending.push(release); })) throw new Error('The engine chunk could not load.');
  return importOriginal();
});

function project(): ImportDetail { const item = detail(); item.capabilities.upload = true; item.upload.available = true; item.publication = 'notStarted'; return item; }
const files = () => ({ [slotId]: new File(['a'.repeat(100)], '01 First.mp3'), [slotTwo]: new File(['b'.repeat(200)], '02 Second.mp3') });
const retained = () => adminWorkspace.buffer(`upload-queue:${projectId}`);
/** Admits every upload as ready and records the asset slots it was sent. */
function serve(start: ImportDetail) {
  let item = start; const uploads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method !== 'POST') return json({ item, receipt: null });
    const slot = decodeURIComponent(path.split('/').at(-1)!), operationId = new Headers(init.headers).get('Idempotency-Key')!; uploads.push(slot);
    item = { ...item, revision: item.revision + 1, assets: [...item.assets, { slotId: slot, state: 'ready', byteLength: 100, sha256: 'a'.repeat(64), contentType: 'audio/mpeg', tags: null, recovery: { operationId, expectedRevision: 1, kind: 'upload', startedByMe: true } }] };
    return json({ item, receipt: { operationId, kind: 'upload', revision: item.revision } });
  }));
  return uploads;
}
const release = async (fail: boolean) => {
  await vi.waitFor(() => expect(loads.pending).toHaveLength(1));
  await act(async () => { loads.pending.shift()!(fail); await new Promise(resolve => setTimeout(resolve, 0)); });
};
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

// These tests share one engine load sequence, so they run in order.
test('until the engine loads, a page shows a new queue\'s idle state and sends nothing, and a failed load drops its commands', async () => {
  const item = project(), uploads = serve(item), { result } = renderHook(() => useImportUploadQueue(projectId));
  expect(result.current).toMatchObject({ running: false, current: null, stopped: null, files: {}, latest: null });
  act(() => result.current.queue.start(item, files(), adminWorkspace.capture()));
  expect(retained()).toBeUndefined(); expect(result.current.running).toBe(false);
  await release(true);
  expect(uploads).toEqual([]); expect(retained()).toBeUndefined(); expect(result.current.files).toEqual({});
});
test('the next load runs the commands issued meanwhile in their order, and the page follows the queue it opens', async () => {
  const item = project(), uploads = serve(item), { result } = renderHook(() => useImportUploadQueue(projectId));
  act(() => { result.current.queue.start(item, files(), adminWorkspace.capture()); result.current.queue.discard(slotTwo); });
  expect(uploads).toEqual([]);
  await release(false);
  await act(async () => { await vi.waitFor(() => expect(retained()).toBeDefined()); await vi.waitFor(() => expect(result.current.running).toBe(false)); });
  // Discarding after Start removed the queued second file before it was sent.
  expect(uploads).toEqual([slotId]); expect(result.current.files).toEqual({ [slotId]: expect.objectContaining({ state: 'ready' }) });
  expect(result.current.latest?.revision).toBe(item.revision + 1); expect(retained()).toBeDefined();
});
test('once the engine has loaded, a page opens its queue on mount, runs commands at once and reopens it without restarting work', async () => {
  const item = project(), uploads = serve(item), mounted = renderHook(() => useImportUploadQueue(projectId));
  expect(retained()).toBeDefined();
  act(() => mounted.result.current.queue.enqueue(slotId, files()[slotId], item, adminWorkspace.capture()));
  expect(mounted.result.current).toMatchObject({ running: true, files: { [slotId]: { state: 'queued' } } });
  await act(async () => { await vi.waitFor(() => expect(mounted.result.current.running).toBe(false)); });
  mounted.unmount();
  const { result } = renderHook(() => useImportUploadQueue(projectId));
  expect(result.current).toMatchObject({ running: false, files: { [slotId]: { state: 'ready' } } });
  expect(uploads).toEqual([slotId]); expect(loads.pending).toHaveLength(0);
});
