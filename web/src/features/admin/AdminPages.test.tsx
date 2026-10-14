import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminWorkbenchPage } from './AdminWorkbenchPage';
import { AdminImportPage } from './AdminImportPage';
import { AdminCreateImportPage } from './AdminCreateImportPage';
import { capabilities, detail, json, projectId, session, viewer } from './adminFixtures.testSupport';

function mount(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}>
    <Link to="/admin/imports/eeeeeeeeeeeeeeeeeeeeeeee">Other project</Link><Routes>
      <Route path="/admin/imports" element={<AdminWorkbenchPage />} />
      <Route path="/admin/imports/new" element={<AdminCreateImportPage />} />
      <Route path="/admin/imports/:importId" element={<AdminImportPage />} />
    </Routes></MemoryRouter></QueryClientProvider>);
  return client;
}
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('workbench distinguishes confirmed empty from failed load and does not query in User view', async () => {
  const fetch = vi.fn(async (path: string, _init: RequestInit) => path.endsWith('capabilities') ? json(capabilities) : json({ code: 'unavailable' }, 503)); vi.stubGlobal('fetch', fetch);
  adminWorkspace.select('user'); mount('/admin/imports'); expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Admin view' }));
  await screen.findByRole('alert'); expect(screen.queryByText('No projects yet. Create an Album draft to begin.')).not.toBeInTheDocument();
  fetch.mockImplementation(async () => json({ items: [], counts: { all: 0, analyzing: 0, awaitingReview: 0, needsAttention: 0, completed: 0 }, nextCursor: null }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('No projects yet. Create an Album draft to begin.'); expect(fetch.mock.calls[1][0]).toContain('limit=25');
});

test('manual edits save only the private draft and never start analysis or publication', async () => {
  let item = detail(); const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push({ path, body }); item = { ...item, revision: 2, draft: body.draft }; return json({ item, receipt: { operationId: body.operationId, revision: 2, kind: 'edit' } }); }
    return json({ item, receipt: null });
  }));
  mount(`/admin/imports/${projectId}`);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Human title' } });
  expect(writes).toHaveLength(0); expect(screen.getByRole('button', { name: 'Analyze again' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByText('Saved to private draft')).toBeVisible());
  expect(writes).toHaveLength(1); expect(writes[0].path).toBe(`/api/admin/v1/imports/${projectId}`);
  expect(writes[0].body).toMatchObject({ expectedRevision: 1, draft: { album: { title: 'Human title', visibility: 'hidden' } } });
});

test('refresh retains unsaved changes until explicitly loading a newer saved version', async () => {
  let item = detail(); vi.stubGlobal('fetch', vi.fn(async () => json({ item, receipt: null })));
  mount(`/admin/imports/${projectId}`);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My unsaved edit' } });
  item = { ...item, revision: 2, draft: { ...item.draft, album: { ...item.draft.album, title: 'Other admin edit' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByRole('button', { name: 'Discard local edits and load saved version' });
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My unsaved edit'); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits and load saved version' }));
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Other admin edit');
});

test('A to B route owns a new mutation and cannot show or retry the earlier project', async () => {
  const other = detail(); other.id = 'eeeeeeeeeeeeeeeeeeeeeeee'; other.manifest.rootLabel = 'Other private Album'; const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'PATCH') { writes.push(path); throw new TypeError('offline'); }
    return json({ item: path.includes(other.id) ? other : detail(), receipt: null });
  }));
  mount(`/admin/imports/${projectId}`);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'A correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); await screen.findByRole('button', { name: 'Retry original operation' });
  fireEvent.click(screen.getByRole('link', { name: 'Other project' })); await screen.findByRole('heading', { name: 'Other private Album' });
  expect(screen.queryByRole('button', { name: 'Retry original operation' })).not.toBeInTheDocument(); expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(''); expect(writes).toHaveLength(1);
  act(() => adminWorkspace.select('user')); expect(screen.queryByRole('heading', { name: 'Other private Album' })).not.toBeInTheDocument();
});

test('file-only intake requires folder context and sends names without uploading bytes', async () => {
  const submitted: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === 'POST') { const body = JSON.parse(String(init.body)); submitted.push(body); return json({ item: detail(), receipt: { kind: 'create', revision: 1, operationId: body.operationId } }, 201); }
    return json({ item: detail(), receipt: null });
  }));
  mount('/admin/imports/new'); const picker = document.querySelectorAll('input[type=file]')[1];
  fireEvent.change(picker, { target: { files: [new File(['synthetic bytes'], 'Song.mp3', { type: 'audio/mpeg' })] } });
  expect(screen.getByRole('textbox', { name: 'Folder or Album context' })).toHaveValue(''); expect(screen.getByRole('button', { name: 'Save Album draft' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder or Album context' }), { target: { value: 'Selected Album' } }); fireEvent.click(screen.getByRole('button', { name: 'Save Album draft' }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]).toMatchObject({ manifest: { rootLabel: 'Selected Album', files: [{ filename: 'Song.mp3', relativePath: 'Song.mp3', byteLength: 15 }] } });
  expect(JSON.stringify(submitted[0])).not.toContain('synthetic bytes');
});

test('cancelled publication cleanup permits manual review while analysis and source mutations stay blocked', async () => {
  const item = detail(); item.publication = 'cancelled'; item.capabilities.upload = true; item.capabilities.publish = true;
  item.publicationRecovery = { operationId: '30000000-0000-4000-8000-000000000003', cleanupPending: true, startedByMe: false };
  vi.stubGlobal('fetch', vi.fn(async () => json({ item, receipt: null })));
  mount(`/admin/imports/${projectId}`);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  expect(title).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Analyze again' })).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '1 · Track number' }));
  expect(screen.getByRole('button', { name: 'Apply selected' })).toBeEnabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Draft' }));
  fireEvent.change(title, { target: { value: 'Review correction while cleanup waits' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});


test('stage navigation keeps private edits and selected suggestions without a mutation', async () => {
  const item = detail(); const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => { if (init.method && init.method !== 'GET') writes.push(path); return json({ item, receipt: null }); }));
  mount(`/admin/imports/${projectId}`);
  await screen.findByRole('textbox', { name: 'Title' });
  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '1 · Track number' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Draft' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unsaved title' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Publish' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  expect(screen.getByRole('checkbox', { name: '1 · Track number' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: '1 · Track number' })).toHaveAccessibleDescription(item.manifest.files[0].relativePath);
  expect(within(screen.getByRole('tabpanel', { name: 'Review' })).getByText(item.manifest.files[0].relativePath)).toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'Home' });
  expect(screen.getByRole('tab', { name: 'Draft' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Unsaved title');
  expect(writes).toEqual([]);
});


test('workbench refresh stays in its header while personal filtering remains with search', async () => {
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { reads.push(path); return json({ items: [], counts: { all: 0, analyzing: 0, awaitingReview: 0, needsAttention: 0, completed: 0 }, nextCursor: null }); }));
  mount('/admin/imports'); await screen.findByText('No projects yet. Create an Album draft to begin.');
  const header = screen.getByRole('heading', { name: 'Workbench' }).closest('header')!;
  expect(within(header).getByRole('button', { name: 'Refresh status' })).toBeVisible();
  expect(within(header).getByRole('link', { name: 'New Album' })).toBeVisible();
  const search = screen.getByRole('textbox', { name: 'Search projects' }).closest('form')!;
  expect(within(search).queryByRole('button', { name: 'Refresh status' })).not.toBeInTheDocument();
  fireEvent.click(within(search).getByRole('checkbox', { name: 'Started by me' }));
  await waitFor(() => expect(reads.some(path => path.includes('startedByMe=true'))).toBe(true));
});
