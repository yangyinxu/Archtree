import { act, cleanup, renderHook } from '@testing-library/react';
import { advanceAccountEpoch, captureAccountOperation } from '../../api/accountEpoch';
import type { UploadProgress } from '../../api/client';
import { adminEndpointRequest } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import { useVideoTransfer } from './useVideoTransfer';
import { uploadVideoFile } from './videoUploadApi';
import { videoProject, videoProjectId, videoViewer } from './videoUploadFixtures.testSupport';

vi.mock('./videoUploadApi', async original => ({ ...await original<typeof import('./videoUploadApi')>(), uploadVideoFile: vi.fn() }));
vi.mock('./adminTransport', async original => ({ ...await original<typeof import('./adminTransport')>(), adminEndpointRequest: vi.fn() }));

let report: (progress: UploadProgress) => void;
let resolve: (result: Awaited<ReturnType<typeof uploadVideoFile>>) => void;
let reject: (error: Error) => void;
const file = new Blob(['original movie']);
const retained = () => adminWorkspace.buffer(`video-transfer:${videoProjectId}`);
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(videoViewer), true, true); adminWorkspace.select('admin');
  vi.mocked(uploadVideoFile).mockImplementation((...args) => {
    report = args[7]!;
    return new Promise((done, fail) => { resolve = done; reject = fail; });
  });
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.clearAllMocks(); });

test('measured bytes update the active transfer but 100% still awaits its receipt', async () => {
  const onResult = vi.fn(), { result } = renderHook(() => useVideoTransfer(videoProjectId, onResult));
  act(() => result.current.upload('source', file, 'source.mov', 3));
  act(() => report({ loaded: 250, total: 1000 }));
  expect(result.current).toMatchObject({ running: true, progress: { loaded: 250, total: 1000 } });
  const intent = result.current.intent!;
  act(() => report({ loaded: 1000, total: 1000 }));
  expect(result.current.running).toBe(true); expect(onResult).not.toHaveBeenCalled();
  await act(async () => resolve({ schemaVersion: 1, item: videoProject(), receipt: { operationId: intent.operationId, revision: 3 } }));
  expect(result.current).toMatchObject({ running: false, progress: null, intent: null });
  expect(onResult).toHaveBeenCalledWith(videoProject(), 'source', intent.operationId);
  act(() => report({ loaded: 1000, total: 1000 }));
  expect(result.current.running).toBe(false);
});

test('a lost receipt clears visible progress and reconciles the same immutable upload without resending', async () => {
  const { result } = renderHook(() => useVideoTransfer(videoProjectId, vi.fn()));
  act(() => result.current.upload('covers', file, 'cover.jpg', 3));
  const intent = result.current.intent!;
  act(() => report({ loaded: 1000, total: 1000 }));
  await act(async () => reject(new Error('lost response')));
  expect(result.current).toMatchObject({ running: false, progress: null, error: 'unknown', intent });
  expect(result.current.intent?.file).toBe(file);
  vi.mocked(adminEndpointRequest).mockResolvedValue({ schemaVersion: 1, item: videoProject() });
  await act(async () => result.current.reconcile(intent.operationId, undefined, true));
  expect(adminEndpointRequest).toHaveBeenCalledWith(`/video-projects/${videoProjectId}/covers/reconcile`, expect.anything(),
    { method: 'POST', body: JSON.stringify({ operationId: intent.operationId }) }, expect.anything());
  expect(uploadVideoFile).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ running: false, progress: null, intent: null });
});

test('a restored transfer retains its bytes but never restores an active progress indicator', () => {
  const guard = adminWorkspace.capture();
  adminWorkspace.retain(`video-transfer:${videoProjectId}`, { running: true, progress: { loaded: 500, total: 1000 },
    intent: { kind: 'source', file, filename: 'source.mov', operationId: crypto.randomUUID(), expectedRevision: 3 }, error: null }, guard);
  const { result } = renderHook(() => useVideoTransfer(videoProjectId, vi.fn()));
  expect(result.current).toMatchObject({ running: false, progress: null, error: 'unknown' });
  expect(result.current.intent?.file).toBe(file); expect(uploadVideoFile).not.toHaveBeenCalled();
});

test('late byte events and responses cannot restore private state after the account changes', async () => {
  const onResult = vi.fn(), { result } = renderHook(() => useVideoTransfer(videoProjectId, onResult));
  act(() => result.current.upload('source', file, 'source.mov', 3));
  act(() => advanceAccountEpoch());
  expect(retained()).toBeUndefined();
  act(() => report({ loaded: 900, total: 1000 }));
  expect(result.current.progress).toEqual({ loaded: 0, total: null });
  await act(async () => reject(new Error('late response')));
  expect(retained()).toBeUndefined(); expect(onResult).not.toHaveBeenCalled();
});
