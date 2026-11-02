import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { CatalogCover } from './CatalogCover';
import { json, session, viewer } from './adminFixtures.testSupport';
import type { CatalogItem } from './catalogApi';
import type { VideoFrame } from './videoFrame';

const picker = vi.hoisted(() => ({ capture: undefined as undefined | ((frame: VideoFrame) => void), url: '' }));
vi.mock('./VideoFramePicker', () => ({ default: (props: { url: string; onClose: () => void; onCapture: (frame: VideoFrame) => void }) => {
  picker.capture = props.onCapture; picker.url = props.url;
  return <div role="dialog" aria-label="Synthetic frame picker"><button onClick={() => props.onCapture({ blob: new Blob([Uint8Array.from([255,216,255,1,2,3])], { type: 'image/jpeg' }), time: 2, duration: 22, width: 1280, height: 720 })}>Capture frame</button><button onClick={props.onClose}>Close picker</button></div>;
} }));

const id = '111111111111111111111111', uploadId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const item: CatalogItem = { kind: 'audioTrack', mediaType: 'video', id, revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public', coverUrl: `/api/admin/v1/catalog/audioTrack/${id}/artwork`, mediaUrl: `/api/admin/v1/catalog/audioTrack/${id}/media`, capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic published Video', releaseDate: null, credits: [], attributionStatus: 'unknown', discNumber: null, trackNumber: null } };
type Sent = { path: string; init: RequestInit };
let uploads: Sent[], changes: Sent[];

/** Tests exercise existing staged-upload and cover-approval contracts, without a private Video project. */
function setup(reply?: (sent: Sent, index: number) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path.endsWith('/cover-uploads')) { const sent = { path, init }; uploads.push(sent); return reply ? reply(sent, uploads.length - 1) : staged(sent); }
    if (init.method === 'POST' || init.method === 'DELETE') { changes.push({ path, init }); return json({ item: { ...item, coverUrl: init.method === 'DELETE' ? null : item.coverUrl }, receipt: { operationId: JSON.parse(String(init.body)).operationId }, coverOperation: { state: 'complete', cleanupPending: false } }); }
    return json({ items: [] });
  }));
  const client = new QueryClient(); client.setQueryData(['browser-session'], session);
  const view = (snapshot: CatalogItem) => <QueryClientProvider client={client}><MemoryRouter><CatalogCover item={snapshot} kind="audioTrack" id={id} disabled={false} onConfirmed={vi.fn()} onRemoved={vi.fn()} /></MemoryRouter></QueryClientProvider>;
  return { ...render(view(item)), view };
}
/** A confirmed source keeps the caller's original upload identity. */
const staged = (sent: Sent) => json({ upload: { id: uploadId }, receipt: { operationId: new Headers(sent.init.headers).get('Idempotency-Key') } });
const bytes = (blob: Blob) => new Promise<number[]>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
/** Operations must be current before admitting a new frame choice. */
async function openPicker() {
  const button = await screen.findByRole('button', { name: 'Choose a Video frame' });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  return screen.findByRole('button', { name: 'Capture frame' });
}

beforeEach(() => {
  uploads = []; changes = []; picker.capture = undefined; picker.url = '';
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-cover-preview'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('published Video exposes all three cover actions and clears its own artwork only after confirmation', async () => {
  setup();
  for (const name of ['Upload image', 'Choose a Video frame', 'Use Album cover or default image']) await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Use Album cover or default image' })); expect(changes).toEqual([]);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove catalog cover' }));
  await waitFor(() => expect(changes).toHaveLength(1)); expect(changes[0].init.method).toBe('DELETE'); expect(JSON.parse(String(changes[0].init.body))).toMatchObject({ expectedRevision: item.revision }); expect(uploads).toEqual([]);
});

test('the published image button opens the image chooser and stages its file without changing the video', async () => {
  setup(); const button = await screen.findByRole('button', { name: 'Upload image' }); await waitFor(() => expect(button).toBeEnabled());
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!, open = vi.spyOn(input, 'click').mockImplementation(() => undefined);
  fireEvent.click(button); expect(open).toHaveBeenCalledOnce();
  const data = Uint8Array.from([255,216,255,1,2,3]), file = new File([data], 'Synthetic cover.jpg'); Object.defineProperty(file, 'arrayBuffer', { value: async () => data.buffer });
  fireEvent.change(input, { target: { files: [file] } });
  const dialog = await screen.findByRole('dialog'); expect(uploads).toHaveLength(1); expect(changes).toEqual([]);
  expect(within(dialog).getByRole('button', { name: 'Replace catalog cover' })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(changes).toEqual([]);
});

test('a frame uses current protected published media and stages JPEG bytes before separate cover confirmation', async () => {
  setup(); fireEvent.click(await openPicker());
  const approval = await screen.findByRole('dialog'); await waitFor(() => expect(within(approval).getByRole('button', { name: 'Replace catalog cover' })).toBeEnabled());
  expect(picker.url).toBe(`${item.mediaUrl}?viewer=${viewer}`); expect(uploads).toHaveLength(1); expect(uploads[0].path).toBe(`/api/admin/v1/catalog/audioTrack/${id}/cover-uploads`); expect(await bytes(uploads[0].init.body as Blob)).toEqual(expect.arrayContaining([255,216,255,1,2,3])); expect(changes).toEqual([]);
  fireEvent.click(within(approval).getByRole('button', { name: 'Replace catalog cover' })); await waitFor(() => expect(changes).toHaveLength(1));
  expect(JSON.parse(String(changes[0].init.body))).toMatchObject({ expectedRevision: item.revision, uploadId }); expect(changes[0].path).toBe(`/api/admin/v1/catalog/audioTrack/${id}/cover`);
});

test('a catalog revision changed while choosing a frame refuses its late capture before upload', async () => {
  const { rerender, view } = setup(); await openPicker();
  rerender(view({ ...item, revision: `cr_${'b'.repeat(43)}` })); fireEvent.click(screen.getByRole('button', { name: 'Capture frame' }));
  await screen.findByRole('alert'); expect(uploads).toEqual([]); expect(changes).toEqual([]); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('an unknown frame upload retries its original bytes and never rebases its approval onto a newer revision', async () => {
  const { rerender, view } = setup((sent, index) => { if (index === 0) throw new TypeError('Synthetic transport loss'); return staged(sent); });
  fireEvent.click(await openPicker()); await screen.findByRole('button', { name: 'Retry original operation' });
  rerender(view({ ...item, revision: `cr_${'b'.repeat(43)}` })); fireEvent.click(screen.getByRole('button', { name: 'Retry original operation' }));
  const dialog = await screen.findByRole('dialog'); await waitFor(() => expect(uploads).toHaveLength(2));
  expect(new Headers(uploads[0].init.headers).get('Idempotency-Key')).toBe(new Headers(uploads[1].init.headers).get('Idempotency-Key')); expect(await bytes(uploads[0].init.body as Blob)).toEqual(await bytes(uploads[1].init.body as Blob));
  expect(within(dialog).getByRole('button', { name: 'Replace catalog cover' })).toBeDisabled(); expect(changes).toEqual([]);
});

test('leaving administrator view fences a frame callback retained by the decoder', async () => {
  setup(); await openPicker(); const capture = picker.capture!;
  act(() => adminWorkspace.select('user')); act(() => capture({ blob: new Blob(['synthetic']), time: 2, duration: 22, width: 1280, height: 720 }));
  expect(uploads).toEqual([]); expect(changes).toEqual([]); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
