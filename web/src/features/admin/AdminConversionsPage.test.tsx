import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminConversionsPage } from './AdminConversionsPage';
import { session, viewer } from './adminFixtures.testSupport';

const mocks = vi.hoisted(() => ({ list: vi.fn(), createLocal: vi.fn(), run: vi.fn(), upload: vi.fn(), stop: vi.fn(),
  source: vi.fn(), listener: null as null | (() => void) }));
vi.mock('./conversionApi', () => ({ conversionApi: { source: mocks.source } }));
vi.mock('./conversionStore', () => ({ conversionStore: { storageSupported: () => true, list: mocks.list, createLocal: mocks.createLocal,
  subscribe: (fn: () => void) => { mocks.listener = fn; return () => { mocks.listener = null; }; }, getOutputFile: vi.fn() } }));
vi.mock('./conversionRunner', () => ({ conversionRunner: { run: mocks.run, upload: mocks.upload, stop: mocks.stop, getActiveBatch: () => null, subscribe: () => () => undefined } }));
function mount(path = '/admin/conversions') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><AdminConversionsPage /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.createLocal.mockResolvedValue({}); mocks.run.mockResolvedValue(undefined); mocks.upload.mockResolvedValue(undefined);
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, undefined, true); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('User view never reads private local task metadata', () => {
  adminWorkspace.select('user'); mount(); expect(mocks.list).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Local MP3 conversion' })).not.toBeInTheDocument();
});

test('selecting lossless files only creates the device task and cannot start encoding or uploading', async () => {
  mount(); const input = document.querySelector('input[accept]')!;
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose FLAC / WAV' })).toBeEnabled());
  fireEvent.change(input, { target: { files: [new File(['source'], 'Track.wav')] } });
  expect(screen.getByRole('textbox', { name: 'Album / batch name' })).toHaveValue('Track');
  fireEvent.click(screen.getByRole('button', { name: 'Create local conversion task' }));
  await waitFor(() => expect(mocks.createLocal).toHaveBeenCalledTimes(1));
  expect(mocks.createLocal.mock.calls[0][0]).toBe(viewer); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
});

test('individual selection preserves extensionless and renamed files for actual decoding', async () => {
  mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Choose FLAC / WAV' })).toBeEnabled());
  const files = [new File(['source'], 'Tone'), new File(['source'], 'Other.data')];
  fireEvent.change(document.querySelector('input[accept]')!, { target: { files } });
  expect(screen.getByRole('textbox', { name: 'Album / batch name' })).toHaveValue('Tone');
  fireEvent.click(screen.getByRole('button', { name: 'Create local conversion task' }));
  await waitFor(() => expect(mocks.createLocal).toHaveBeenCalledTimes(1));
  expect(mocks.createLocal.mock.calls[0][1]).toEqual(files);
});

/** The browser File API reads only a short signature during folder intake. */
function folderFile(name: string, signature: string, read?: () => Promise<ArrayBuffer>) {
  const file = new File(['source'], name);
  Object.defineProperties(file, {
    webkitRelativePath: { value: `Album/${name}` },
    slice: { value: () => ({ arrayBuffer: read ?? (() => Promise.resolve(new TextEncoder().encode(signature).buffer)) }) }
  });
  return file;
}

test('folder intake recognizes lossless bytes with any filename and skips unrelated artwork', async () => {
  mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Choose an Album folder' })).toBeEnabled());
  const files = [folderFile('Tone', 'fLaC'), folderFile('Other.data', 'RIFFxxxxWAVE'), folderFile('Broken.wav', 'bad'), folderFile('cover.jpg', 'image')];
  fireEvent.change(document.querySelector('input[type=file]:not([accept])')!, { target: { files } });
  await screen.findByRole('textbox', { name: 'Album / batch name' });
  fireEvent.click(screen.getByRole('button', { name: 'Create local conversion task' }));
  await waitFor(() => expect(mocks.createLocal).toHaveBeenCalledTimes(1));
  expect(mocks.createLocal.mock.calls[0][1]).toEqual(files.slice(0, 3));
  expect(mocks.createLocal.mock.calls[0][2]).toBe('Album');
});

test('a late folder scan cannot overwrite a newer file selection', async () => {
  mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Choose an Album folder' })).toBeEnabled());
  let finish!: (value: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
  fireEvent.change(document.querySelector('input[type=file]:not([accept])')!, { target: { files: [folderFile('Old', '', () => pending)] } });
  const newer = new File(['source'], 'New.wav');
  fireEvent.change(document.querySelector('input[accept]')!, { target: { files: [newer] } });
  await act(async () => { finish(new TextEncoder().encode('fLaC').buffer); });
  expect(screen.getByRole('textbox', { name: 'Album / batch name' })).toHaveValue('New');
  fireEvent.click(screen.getByRole('button', { name: 'Create local conversion task' }));
  await waitFor(() => expect(mocks.createLocal).toHaveBeenCalledTimes(1));
  expect(mocks.createLocal.mock.calls[0][1]).toEqual([newer]);
});

test('an invalid replacement selection clears the previous pending files', async () => {
  mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Choose FLAC / WAV' })).toBeEnabled());
  const input = document.querySelector('input[accept]')!;
  fireEvent.change(input, { target: { files: [new File(['source'], 'Old.wav')] } });
  fireEvent.change(input, { target: { files: Array.from({ length: 101 }, (_, index) => new File(['source'], `Track-${index}.wav`)) } });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Create local conversion task' })).not.toBeInTheDocument();
  expect(mocks.createLocal).not.toHaveBeenCalled();
});

test('an empty Album explains the unavailable source and cannot create an empty device task', async () => {
  mocks.source.mockResolvedValue({ schemaVersion: 1, album: { id: viewer, title: 'Empty Album' }, tracks: [] });
  mount(`\u002fadmin/conversions?album=${viewer}`);
  expect(await screen.findByText('No playable MediaTracks are linked yet.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create local conversion task' })).toBeDisabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a changed frozen output disables replacement confirmation', async () => {
  const result = { sampleRate: 48000, channels: 1, outputBytes: 100, outputSha256: 'a'.repeat(64) };
  const task = { id: 'task', title: 'Track', filename: 'Track.wav', source: { kind: 'remote', complete: true }, result, intent: null,
    status: 'complete', error: null, cacheRemoved: false };
  let batch = { id: 'batch', rootLabel: 'Album', kind: 'existing', tasks: [task] };
  mocks.list.mockImplementation(async () => [batch]); mount();
  await screen.findByRole('button', { name: 'Download MP3' }); fireEvent.click(screen.getByRole('button', { name: 'Review MP3 replacement' }));
  const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText(/Replace online audio/)).toBeVisible();
  batch = { ...batch, tasks: [{ ...task, result: { ...result, outputSha256: 'b'.repeat(64) } }] };
  await act(async () => { mocks.listener?.(); });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Upload / reconcile MP3s' })).toBeDisabled());
  expect(mocks.upload).not.toHaveBeenCalled();
});

test.each([false, true])('closed conversion admission allows only existing-operation recovery (intent=%s)', async hasIntent => {
  adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, undefined, false);
  mocks.list.mockResolvedValue([{ id: 'batch', rootLabel: 'Album', kind: 'existing', tasks: [{ id: 'task', title: 'Track', filename: 'Track.wav',
    source: { kind: 'remote', complete: true }, result: { sampleRate: 48000, channels: 1, outputBytes: 100, outputSha256: 'a'.repeat(64) },
    intent: hasIntent ? { operationId: 'existing-operation' } : null, status: 'complete', error: null, cacheRemoved: false }] }]);
  mount(); const action = await screen.findByRole('button', { name: 'Review MP3 replacement' });
  if (hasIntent) expect(action).toBeEnabled(); else expect(action).toBeDisabled();
  expect(mocks.upload).not.toHaveBeenCalled();
});
