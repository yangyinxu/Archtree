import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogPage } from './AdminCatalogPage';
import { AdminPagesPage } from './AdminPagesPage';
import { deferred, json, session, viewer } from './adminFixtures.testSupport';
import type { CatalogItem } from './catalogApi';
const album = (): CatalogItem => ({ kind: 'album', id: '111111111111111111111111', revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public', coverUrl: null, mediaUrl: null, capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' } });
function mount(element: React.ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session); render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>); return client; }
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test('existing catalog save is explicit, partial and preserves unsaved edits on revision conflict', async () => {
  const item = album(); const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return json({ code: 'revision' }, 409); } return json({ item }); }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Human correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(writes).toHaveLength(0);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert'); expect(writes[0]).toMatchObject({ expectedRevision: item.revision, fields: { title: 'Human correction' } }); expect(Object.keys(writes[0].fields)).toEqual(['title']);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Human correction');
});
test('lost catalog response retries the same intent and leaving Admin destroys its private preview', async () => {
  const item = { ...album(), kind: 'audioTrack' as const, fields: { ...album().fields, title: 'Synthetic track', releaseDate: null, credits: null, attributionStatus: 'unknown' as const, trackNumber: 1 }, mediaUrl: '/api/admin/v1/catalog/audioTrack/111111111111111111111111/media' };
  const bodies: string[] = []; const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { bodies.push(String(init.body)); throw new TypeError('offline'); } return json({ item }); }));
  mount(<AdminCatalogPage kind="audioTrack" id={item.id} />); fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Changed' } }); fireEvent.click(screen.getByRole('button', { name: 'Save' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original operation' })); await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[0]).toBe(bodies[1]);
  const audio = document.querySelector('audio')!; expect(audio.getAttribute('src')).toContain(`viewer=${viewer}`);
  act(() => adminWorkspace.select('user')); expect(document.querySelector('audio')).toBeNull(); expect(audio.hasAttribute('src')).toBe(false); expect(pause).toHaveBeenCalled(); expect(load).toHaveBeenCalled();
});
test('late catalog read cannot revert a confirmed mutation', async () => {
  let item = album(); const late = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { const payload = JSON.parse(String(init.body)); item = { ...item, revision: `cr_${'b'.repeat(43)}`, fields: { ...item.fields, ...payload.fields } }; return json({ item, receipt: { operationId: payload.operationId } }); } if (++reads === 2) return late.promise; return json({ item }); }));
  mount(<AdminCatalogPage kind="album" id={item.id} />); fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Confirmed correction' } }); fireEvent.click(screen.getAllByRole('button', { name: 'Refresh status' })[0]); fireEvent.click(screen.getByRole('button', { name: 'Save' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(reads).toBe(3)); late.resolve(json({ item: album() })); await act(async () => { await Promise.resolve(); }); expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Confirmed correction');
});
test.each([false, true])('an explicit missing owner clears its buffered metadata and permits revisionless cover recovery (dirty=%s)', async dirty => {
  const item = album(), originalOperationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let missing = false;
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return json({ item: null, receipt: { operationId: body.operationId }, coverOperation: { state: 'cancelled', cleanupPending: false } });
    }
    if (path.endsWith('/cover-operations')) return json({ items: [{ operationId: originalOperationId, startedByMe: true, state: 'needsAttention', cleanupPending: false }] });
    return missing ? json({ code: 'ADMIN_CATALOG_NOT_FOUND' }, 404) : json({ item });
  }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  if (dirty) fireEvent.change(title, { target: { value: 'Unsaved deleted title' } });
  await waitFor(() => expect(adminWorkspace.buffer(`catalog:album:${item.id}`)).toBeDefined());
  act(() => adminWorkspace.select('user'));
  missing = true;
  act(() => adminWorkspace.select('admin'));
  const missingAlert = await screen.findByRole('alert');
  expect(missingAlert).toHaveTextContent('This content no longer exists. You can still recover its unfinished cover operation.');
  expect(missingAlert).not.toHaveTextContent('Your saved draft is retained.');
  expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  expect(adminWorkspace.buffer(`catalog:album:${item.id}`)).toBeUndefined();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel approval' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel approval' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ expectedRevision: null });
});
test('a transient catalog failure retains the account-fenced draft and its revision', async () => {
  const item = album();
  adminWorkspace.retain(`catalog:album:${item.id}`, { base: item, fields: { ...item.fields, title: 'Unsaved correction' }, visibility: 'public', dirty: true }, adminWorkspace.capture());
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ code: 'unavailable' }, 503)));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('The request could not be confirmed. Your saved draft is retained.');
  expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Unsaved correction');
  expect(adminWorkspace.buffer<{ base: CatalogItem }>(`catalog:album:${item.id}`)?.base.revision).toBe(item.revision);
});
test('Page visibility patches only the confirmed occurrence and its captured page revision', async () => {
  const page = { slug: 'home', title: 'Home', revision: `cr_${'a'.repeat(43)}`, items: [{ itemId: '222222222222222222222222', itemType: 'carousel', referenceId: 'shared-carousel', order: 0, visibility: 'public', name: 'Featured releases', sourceMode: 'manual', referenceStatus: 'ready' }] }; const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => { if (init.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push({ path, body }); return json({ page: { ...page, revision: `cr_${'b'.repeat(43)}`, items: [{ ...page.items[0], visibility: 'hidden' }] }, receipt: { operationId: body.operationId } }); } return json({ page }); }));
  mount(<AdminPagesPage />); fireEvent.click(await screen.findByRole('button', { name: 'Hide this placement' })); expect(writes).toHaveLength(0);
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('1 · Featured releases')).toBeVisible();
  expect(dialog.getByText('Public → Hidden')).toBeVisible();
  fireEvent.click(dialog.getByRole('button', { name: 'Hide this placement' })); await waitFor(() => expect(writes).toHaveLength(1)); expect(writes[0]).toMatchObject({ path: '/api/admin/v1/pages/home/items/222222222222222222222222', body: { expectedRevision: page.revision, visibility: 'hidden' } }); expect(writes[0].body).not.toHaveProperty('referenceId');
});
test('Page placements keep missing and unsupported references identifiable', async () => {
  const page = { slug: 'home', title: 'Home', revision: `cr_${'a'.repeat(43)}`, items: [
    { itemId: '222222222222222222222222', itemType: 'grid', referenceId: 'missing-grid', order: 0, visibility: 'public', name: null, sourceMode: null, referenceStatus: 'missing' },
    { itemId: '333333333333333333333333', itemType: 'list', referenceId: 'old-list', order: 1, visibility: 'hidden', name: 'Legacy list', sourceMode: null, referenceStatus: 'unsupported' }
  ] };
  vi.stubGlobal('fetch', vi.fn(async () => json({ page })));
  mount(<AdminPagesPage />);
  expect(await screen.findByText('Referenced content is missing')).toBeVisible();
  expect(screen.getByText('Unsupported reference')).toBeVisible();
  expect(screen.getByRole('heading', { name: '1 · Unnamed placement' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '2 · Legacy list' })).toBeVisible();
});
test('a placement rename or source change invalidates its open visibility approval', async () => {
  let page = { slug: 'home', title: 'Home', revision: `cr_${'a'.repeat(43)}`, items: [{ itemId: '222222222222222222222222', itemType: 'grid', referenceId: 'shared-grid', order: 0, visibility: 'public', name: 'Featured releases', sourceMode: 'manual', referenceStatus: 'ready' }] };
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (init.method === 'PATCH') writes.push(String(init.body)); return json({ page }); }));
  const client = mount(<AdminPagesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hide this placement' }));
  page = { ...page, revision: `cr_${'b'.repeat(43)}`, items: [{ ...page.items[0], name: 'Popular recordings', sourceMode: 'dynamic' }] };
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Hide this placement' })).toBeDisabled());
  expect(writes).toHaveLength(0);
});
