import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogPage } from './AdminCatalogPage';
import { CatalogEditConfirmation } from './CatalogEditConfirmation';
import { catalogPatch } from './catalogApi';
import { AdminPagesPage } from './AdminPagesPage';
import { deferred, json, session, viewer } from './adminFixtures.testSupport';
import type { CatalogItem } from './catalogApi';
const album = (): Extract<CatalogItem, { kind: 'album' }> => ({ kind: 'album', id: '111111111111111111111111', revision: `cr_${'a'.repeat(43)}`, visibility: 'public', effectiveVisibility: 'public', coverUrl: null, mediaUrl: null, capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' } });
function mount(element: React.ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session); render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>); return client; }
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin'); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); onlineManager.setOnline(true); });
test('Album inventory uses its private cover and title as one detail entry without repeated management actions', async () => {
  const item = { ...album(), coverUrl: '/api/admin/v1/catalog/album/111111111111111111111111/artwork', fields: { ...album().fields, releaseDate: { year: 2024, month: null, day: null } } };
  adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }, true);
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [item], nextCursor: null })));
  mount(<AdminCatalogPage />);
  const link = await screen.findByRole('link', { name: item.fields.title });
  expect(link).toHaveAttribute('href', `/admin/catalog/album/${item.id}`);
  expect(link).toHaveAccessibleDescription('Public · 2024');
  const image = link.querySelector('img')!;
  expect(image).toHaveAttribute('src', `${item.coverUrl}?viewer=${viewer}`);
  expect(image).toHaveAttribute('alt', ''); expect(image).not.toHaveAttribute('srcset');
  expect(screen.queryByRole('link', { name: 'Edit manually' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review existing Album' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Convert to MP3' })).not.toBeInTheDocument();
  act(() => adminWorkspace.select('user')); expect(document.querySelector('img')).toBeNull();
});

test('Album details display the saved cover and keep all management actions behind the detail entry', async () => {
  const item = { ...album(), coverUrl: '/api/admin/v1/catalog/album/111111111111111111111111/artwork', fields: { ...album().fields, releaseDate: { year: 2024, month: 1, day: null } } };
  adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }, true);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  const image = await screen.findByRole('img', { name: `${item.fields.title} cover` });
  expect(image).toHaveAttribute('src', `${item.coverUrl}?viewer=${viewer}`); expect(image).not.toHaveAttribute('srcset');
  expect(image).toHaveAttribute('loading', 'eager');
  expect(screen.getByText('Public · 2024-01')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Back to catalog' })).toHaveAttribute('href', '/admin/catalog');
  const actions = within(screen.getByRole('group', { name: 'Edit catalog content' }));
  expect(actions.getByRole('link', { name: 'Edit manually' })).toHaveAttribute('href', '#catalog-details');
  expect(await actions.findByRole('button', { name: 'Review existing Album' })).toBeEnabled();
  expect(actions.getByRole('link', { name: 'Convert to MP3' })).toHaveAttribute('href', `/admin/conversions?album=${item.id}`);
  expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue(item.fields.title);
});

test.each(['inventory', 'details'] as const)('explicit %s refresh retries a failed private cover without exposing a public URL', async mode => {
  const item = { ...album(), coverUrl: '/api/admin/v1/catalog/album/111111111111111111111111/artwork' }; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/cover-operations')) return json({ items: [] });
    reads++; return mode === 'inventory' ? json({ items: [item], nextCursor: null }) : json({ item });
  }));
  mount(mode === 'inventory' ? <AdminCatalogPage /> : <AdminCatalogPage kind="album" id={item.id} />);
  await waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  const original = document.querySelector('img')!; fireEvent.error(original); expect(document.querySelector('img')).toBeNull();
  const previousReads = reads; fireEvent.click(screen.getAllByRole('button', { name: 'Refresh status' })[0]);
  await waitFor(() => expect(reads).toBeGreaterThan(previousReads));
  const recovered = document.querySelector('img')!; expect(recovered).not.toBe(original);
  expect(recovered).toHaveAttribute('src', `${item.coverUrl}?viewer=${viewer}`); expect(recovered).not.toHaveAttribute('srcset');
});

test('existing catalog save is explicit, partial and preserves unsaved edits on revision conflict', async () => {
  const item = album(); const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return json({ code: 'revision' }, 409); } return json({ item }); }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  expect(screen.getByText('Saving confirmed changes updates this existing item directly.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  fireEvent.change(title, { target: { value: 'Human correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' })); expect(writes).toHaveLength(0);
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save catalog changes' }));
  await screen.findByRole('alert'); expect(writes[0]).toMatchObject({ expectedRevision: item.revision, fields: { title: 'Human correction' } }); expect(Object.keys(writes[0].fields)).toEqual(['title']);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Human correction');
});
test('lost catalog response retries the same intent and leaving Admin destroys its private preview', async () => {
  const item = { ...album(), kind: 'audioTrack' as const, fields: { ...album().fields, title: 'Synthetic track', releaseDate: null, credits: null, attributionStatus: 'unknown' as const, trackNumber: 1 }, mediaUrl: '/api/admin/v1/catalog/audioTrack/111111111111111111111111/media' };
  const bodies: string[] = []; const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { bodies.push(String(init.body)); throw new TypeError('offline'); } return json({ item }); }));
  mount(<AdminCatalogPage kind="audioTrack" id={item.id} />); fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Changed' } }); fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' })); fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save catalog changes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original operation' })); await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[0]).toBe(bodies[1]);
  const audio = document.querySelector('audio')!; expect(audio.getAttribute('src')).toContain(`viewer=${viewer}`);
  act(() => adminWorkspace.select('user')); expect(document.querySelector('audio')).toBeNull(); expect(audio.hasAttribute('src')).toBe(false); expect(pause).toHaveBeenCalled(); expect(load).toHaveBeenCalled();
});
test('late catalog read cannot revert a confirmed mutation', async () => {
  let item = album(); const late = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => { if (_path.endsWith('/cover-operations')) return json({items:[]}); if (init.method === 'PATCH') { const payload = JSON.parse(String(init.body)); item = { ...item, revision: `cr_${'b'.repeat(43)}`, fields: { ...item.fields, ...payload.fields } }; return json({ item, receipt: { operationId: payload.operationId } }); } if (++reads === 2) return late.promise; return json({ item }); }));
  mount(<AdminCatalogPage kind="album" id={item.id} />); fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Confirmed correction' } }); fireEvent.click(screen.getAllByRole('button', { name: 'Refresh status' })[0]); fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' })); fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save catalog changes' }));
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

test('manual confirmation shows exactly the frozen partial patch and omits unchanged fields', async () => {
  const item = { ...album(), fields: { ...album().fields, releaseDate: { year: 2020, month: null, day: null } } };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: [] });
    if (init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return json({ item: { ...item, revision: `cr_${'b'.repeat(43)}`, visibility: 'hidden', effectiveVisibility: 'hidden', fields: { ...item.fields, ...body.fields } }, receipt: { operationId: body.operationId } });
    }
    return json({ item });
  }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Frozen correction' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Month' }), { target: { value: '5' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Day' }), { target: { value: '6' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Visibility' }), { target: { value: 'hidden' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getAllByRole('article')).toHaveLength(3);
  for (const [field, before, after] of [['Title', item.fields.title, 'Frozen correction'], ['Release date', '2020', '2020-05-06'], ['Visibility', 'Public', 'Hidden']]) {
    const row = within(dialog).getByRole('heading', { name: field }).closest('article')!;
    expect(within(row).getByText('Captured saved value')).toBeVisible();
    expect(within(row).getByText('Value to apply')).toBeVisible();
    expect(within(row).getByText(before, { exact: true })).toBeVisible();
    expect(within(row).getByText(after, { exact: true })).toBeVisible();
  }
  expect(within(dialog).queryByRole('heading', { name: 'Credits' })).not.toBeInTheDocument();
  expect(writes).toEqual([]);
  // A background form change must not change the confirmation or the dispatched intent.
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Later local change' } });
  expect(within(dialog).queryByText('Later local change')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save catalog changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ expectedRevision: item.revision, fields: { title: 'Frozen correction', releaseDate: { year: 2020, month: 5, day: 6 } }, visibility: 'hidden' });
  expect(Object.keys(writes[0].fields as object)).toEqual(['title', 'releaseDate']);
});

test('a stale confirmation explains recovery, preserves edits on cancel, and requires a fresh snapshot', async () => {
  let item = album(); const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: [] });
    if (init.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push(body); return json({ item, receipt: { operationId: body.operationId } }); }
    return json({ item });
  }));
  const client = mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My retained correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  const dialog = await screen.findByRole('dialog');
  item = { ...item, revision: `cr_${'b'.repeat(43)}`, fields: { ...item.fields, title: 'External correction' } };
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Close this dialog and review the latest saved version');
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Your unsaved edits are still available.');
  const save = within(dialog).getByRole('button', { name: 'Save catalog changes' });
  expect(save).toBeDisabled(); fireEvent.click(save); expect(writes).toEqual([]);
  expect(within(dialog).getByText('My retained correction')).toBeVisible();
  expect(within(dialog).queryByText('External correction')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My retained correction');
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits and load saved version' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Reviewed new correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  const next = await screen.findByRole('dialog');
  expect(within(next).queryByRole('alert')).not.toBeInTheDocument();
  const titleRow = within(next).getByRole('heading', { name: 'Title' }).closest('article')!;
  expect(within(titleRow).getByText('External correction')).toBeVisible();
  fireEvent.click(within(next).getByRole('button', { name: 'Save catalog changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ expectedRevision: item.revision, fields: { title: 'Reviewed new correction' } });
});

test('offline and failed reads do not masquerade as a stale confirmation', async () => {
  const item = album(); let failing = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : failing ? json({ code: 'unavailable' }, 503) : json({ item })));
  const client = mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Local correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  const dialog = await screen.findByRole('dialog');
  failing = true;
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  vi.stubGlobal('navigator', { ...navigator, onLine: false });
  act(() => window.dispatchEvent(new Event('offline')));
  expect(within(dialog).getByRole('button', { name: 'Save catalog changes' })).toBeDisabled();
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
});

test.each([
  ['editing', 'dto'], ['visibility', 'dto'], ['editing', 'workspace'], ['visibility', 'workspace']
] as const)('same-revision %s capability loss from %s preserves the draft and blocks its frozen confirmation', async (capability, source) => {
  let item = album(); const original = item, writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: [] });
    if (init.method === 'PATCH') writes.push(String(init.body));
    return json({ item });
  }));
  const client = mount(<AdminCatalogPage kind="album" id={item.id} />);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  const control = capability === 'editing' ? title : screen.getByRole('combobox', { name: 'Visibility' });
  const value = capability === 'editing' ? 'My retained correction' : 'hidden';
  fireEvent.change(control, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  const dialog = await screen.findByRole('dialog');
  if (source === 'dto') {
    item = { ...item, capabilities: { ...item.capabilities, [capability]: false } };
    await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  } else act(() => adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined,
    { editing: capability !== 'editing', visibility: capability !== 'visibility' }));
  await waitFor(() => expect(control).toBeDisabled()); expect(control).toHaveValue(value);
  if (capability === 'editing') expect(screen.getByRole('button', { name: 'Edit manually' })).toBeDisabled();
  const save = within(dialog).getByRole('button', { name: 'Save catalog changes' });
  expect(save).toBeDisabled(); fireEvent.click(save); expect(writes).toEqual([]);
  expect(adminWorkspace.buffer<{ base: CatalogItem; dirty: boolean }>(`catalog:album:${item.id}`)).toMatchObject({ base: { revision: original.revision }, dirty: true });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(control).toHaveValue(value); expect(screen.getByRole('button', { name: 'Save catalog changes' })).toBeDisabled();
  if (source === 'dto') {
    item = original; await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  } else act(() => adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }));
  await waitFor(() => expect(control).toBeEnabled()); expect(control).toHaveValue(value);
  expect(screen.getByRole('button', { name: 'Save catalog changes' })).toBeEnabled();
});

test('an unknown manual operation permits read-only refresh while retaining its exact intent and unsaved values', async () => {
  let item = album(), reads = 0; const pending = deferred<Response>(), bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: [] });
    if (init.method === 'PATCH') { bodies.push(String(init.body)); return pending.promise; }
    reads++; return json({ item });
  }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Unconfirmed correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save catalog changes' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save catalog changes' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  const refresh = screen.getAllByRole('button', { name: /^Refresh/ })[0]; expect(refresh).toBeDisabled();
  await act(async () => { pending.resolve(json({ code: 'Synthetic_unconfirmed_write' }, 503)); });
  await screen.findByRole('button', { name: 'Retry original operation' });
  const command = adminWorkspace.buffer<{ getSnapshot: () => { intent: { body: string; operationId: string } } }>(`command:catalog:album:${item.id}`)!;
  const intent = command.getSnapshot().intent, previousReads = reads;
  expect(refresh).toBeEnabled();
  item = { ...item, revision: `cr_${'b'.repeat(43)}`, fields: { ...item.fields, title: 'Current saved title' } };
  fireEvent.click(refresh); await waitFor(() => expect(reads).toBeGreaterThan(previousReads));
  await screen.findByRole('button', { name: 'Discard local edits and load saved version' });
  expect(command.getSnapshot().intent).toEqual(intent); expect(bodies).toHaveLength(1);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Unconfirmed correction');
  expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
});

test('historical cover cleanup preserves dirty manual values and exposes a changed saved revision for explicit review', async () => {
  const item = album(), operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let current = item, recovered = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: recovered ? [] : [{ operationId, state: 'cancelled', cleanupPending: true, startedByMe: false }] });
    if (path.endsWith('/reconcile') && init.method === 'POST') {
      recovered = true; current = { ...item, revision: `cr_${'b'.repeat(43)}` };
      return json({ item: current, receipt: { operationId }, coverOperation: { state: 'cancelled', cleanupPending: false } });
    }
    return json({ item: current });
  }));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My retained draft' } });
  const recover = await screen.findByRole('button', { name: 'Retry cleanup' }); expect(recover).toBeEnabled();
  fireEvent.click(recover); await waitFor(() => expect(recovered).toBe(true));
  await screen.findByRole('button', { name: 'Discard local edits and load saved version' });
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My retained draft');
  expect(adminWorkspace.buffer<{ base: CatalogItem; dirty: boolean }>(`catalog:album:${item.id}`)).toMatchObject({ base: { revision: item.revision }, dirty: true });
});

test('historical cover cancellation binds the latest saved owner while retaining an older dirty manual baseline', async () => {
  const original = album(), operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let current = original, cancelled = false; const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/cover-operations')) return json({ items: cancelled ? [] : [{ operationId, state: 'needsAttention', cleanupPending: false, startedByMe: false }] });
    if (path.endsWith('/cancel') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (body.expectedRevision !== current.revision) return json({ code: 'ADMIN_CATALOG_REVISION_CONFLICT' }, 409);
      cancelled = true;
      return json({ item: current, receipt: { operationId: body.operationId }, coverOperation: { state: 'cancelled', cleanupPending: false } });
    }
    return json({ item: current });
  }));
  const client = mount(<AdminCatalogPage kind="album" id={original.id} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'My retained manual correction' } });
  current = { ...original, revision: `cr_${'b'.repeat(43)}`, fields: { ...original.fields, title: 'Latest saved Album title' } };
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  await screen.findByRole('button', { name: 'Discard local edits and load saved version' });
  const cancel = await screen.findByRole('button', { name: 'Cancel approval' }); expect(cancel).toBeEnabled(); fireEvent.click(cancel);
  const dialog = within(screen.getByRole('dialog')); expect(dialog.getByText(current.fields.title)).toBeVisible();
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel approval' }));
  await waitFor(() => expect(cancelled).toBe(true));
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedRevision: current.revision });
  expect(writes[0].operationId).not.toBe(operationId);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My retained manual correction');
  expect(screen.getByRole('button', { name: 'Discard local edits and load saved version' })).toBeVisible();
  expect(adminWorkspace.buffer<{ base: CatalogItem; dirty: boolean }>(`catalog:album:${original.id}`)).toMatchObject({ base: { revision: original.revision }, dirty: true });
});

test.each(['fields', 'visibility'])('reverting %s unlocks review and artwork without an empty save', async source => {
  const item = album();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item })));
  mount(<AdminCatalogPage kind="album" id={item.id} />);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  const control = source === 'fields' ? title : screen.getByRole('combobox', { name: 'Visibility' });
  fireEvent.change(control, { target: { value: source === 'fields' ? 'Temporary correction' : 'hidden' } });
  expect(await screen.findByRole('button', { name: 'Review existing Album' })).toBeDisabled();
  fireEvent.change(control, { target: { value: source === 'fields' ? item.fields.title : 'public' } });
  expect(screen.getByRole('button', { name: 'Save catalog changes' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review existing Album' })).toBeEnabled();
  expect(await screen.findByRole('button', { name: 'Choose from import projects' })).toBeEnabled();
  expect(screen.queryByText('Save your catalog edits before creating a review.')).not.toBeInTheDocument();
  expect(adminWorkspace.buffer<{ dirty: boolean }>(`catalog:album:${item.id}`)?.dirty).toBe(false);
});

test('reverting a draft after observing a newer revision retains the explicit recovery path', async () => {
  let item = album(); const original = item;
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method && init.method !== 'GET') writes.push(String(init.body));
    return path.endsWith('/cover-operations') ? json({ items: [] }) : json({ item });
  }));
  const client = mount(<AdminCatalogPage kind="album" id={item.id} />);
  const title = await screen.findByRole('textbox', { name: 'Title' });
  fireEvent.change(title, { target: { value: 'Local correction' } });
  item = { ...item, revision: `cr_${'b'.repeat(43)}`, fields: { ...item.fields, title: 'New saved version' } };
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  await screen.findByRole('button', { name: 'Discard local edits and load saved version' });
  fireEvent.change(title, { target: { value: original.fields.title } });
  expect(screen.getByRole('button', { name: 'Save catalog changes' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review existing Album' })).toBeDisabled();
  await act(async () => { await client.refetchQueries({ queryKey: ['admin-imports'] }); });
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits and load saved version' }));
  expect(title).toHaveValue('New saved version');
  expect(screen.getByRole('button', { name: 'Review existing Album' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(writes).toEqual([]);
});

test('confirmation distinguishes unavailable Credits from explicit removal and includes coupled attribution', () => {
  const item = album();
  const fields = { ...item.fields, credits: [], attributionStatus: 'unknown' as const };
  mount(<CatalogEditConfirmation snapshot={{ item, patch: catalogPatch(item, fields, 'public') }} stale={false} disabled={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
  const row = screen.getByRole('heading', { name: 'Credits' }).closest('article')!;
  expect(within(row).getByText('Credit details unavailable')).toBeVisible();
  expect(within(row).getByText('No credits')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Attribution' })).toBeVisible();
});

test.each([false, true])('Credit differences retain names, localized roles and list order when name lookup fails=%s', async failing => {
  const creditId = 'credit-one', subjectId = '222222222222222222222222';
  const credits = [{ creditId, subjectType: 'artist' as const, subjectId, role: 'primary' as const, order: 0 }];
  const item = { ...album(), fields: { ...album().fields, credits, attributionStatus: 'documented' as const } };
  const fields = { ...item.fields, credits: [{ ...credits[0], role: 'producer' as const }] };
  vi.stubGlobal('fetch', vi.fn(async () => failing ? json({ code: 'unavailable' }, 503)
    : json({ item: { ...album(), id: subjectId, kind: 'artist', fields: { name: 'Credit artist', bio: '', birthDate: null } } })));
  mount(<CatalogEditConfirmation snapshot={{ item, patch: catalogPatch(item, fields, 'public') }} stale={false} disabled={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
  const row = screen.getByRole('heading', { name: 'Credits' }).closest('article')!;
  const values = within(row);
  expect(await values.findByText(failing ? `Name unavailable · ${subjectId} · Artists · Primary` : 'Credit artist · Artists · Primary')).toBeVisible();
  expect(values.getByText(failing ? `Name unavailable · ${subjectId} · Artists · Producer` : 'Credit artist · Artists · Producer')).toBeVisible();
  expect(values.getAllByRole('list')).toHaveLength(2);
  expect(values.queryByText(/creditId/)).not.toBeInTheDocument();
});

test('same-named Credit replacements remain distinguishable by their exact records', async () => {
  const firstId = '222222222222222222222222', secondId = '333333333333333333333333';
  const credit = { creditId: 'credit-one', subjectType: 'artist' as const, subjectId: firstId, role: 'primary' as const, order: 0 };
  const item = { ...album(), fields: { ...album().fields, credits: [credit], attributionStatus: 'documented' as const } };
  const fields = { ...item.fields, credits: [{ ...credit, subjectId: secondId }] };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => json({ item: { ...album(), id: path.split('/').at(-1), kind: 'artist', fields: { name: 'Same artist name', bio: '', birthDate: null } } })));
  mount(<CatalogEditConfirmation snapshot={{ item, patch: catalogPatch(item, fields, 'public') }} stale={false} disabled={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByText('Same artist name · Artists · Primary')).toHaveLength(2));
  expect(screen.queryByRole('link', { name: firstId, hidden: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: secondId, hidden: true })).not.toBeInTheDocument();
  const summaries = screen.getAllByText('Verify credited record');
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(summaries[0]).toHaveFocus();
  screen.getByRole('dialog').focus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Save catalog changes' })).toHaveFocus();
  fireEvent.click(summaries[0]);
  fireEvent.click(summaries[1]);
  const before = await screen.findByRole('link', { name: firstId });
  const after = await screen.findByRole('link', { name: secondId });
  expect(before).toHaveAttribute('href', `/admin/catalog/artist/${firstId}`);
  expect(after).toHaveAttribute('href', `/admin/catalog/artist/${secondId}`);
  expect(before).toBeVisible(); expect(after).toBeVisible();
});

test.each([
  ['artist', { name: 'Old artist', bio: 'Old biography', birthDate: { year: 1980, month: 2, day: null } }, { name: 'New artist', bio: 'Line one\nLine two', birthDate: null }, ['Name', 'Biography', 'Birth date'], ['New artist', 'Line one\nLine two', '—']],
  ['organization', { name: 'Old organization', description: 'Old description', organizationType: 'label' }, { name: 'New organization', description: 'New description', organizationType: 'archive' }, ['Name', 'Description', 'Organization type'], ['New organization', 'New description', 'Archive']],
  ['audioTrack', { title: 'Old track', releaseDate: null, credits: null, attributionStatus: 'unknown', trackNumber: 1 }, { title: 'New track', releaseDate: { year: 2021, month: 3, day: null }, credits: null, attributionStatus: 'unknown', trackNumber: null }, ['Title', 'Release date', 'Track number'], ['New track', '2021-03', '—']]
])('manual %s confirmation uses human labels and complete values', (_kind, previous, next, labels, values) => {
  const item = { ...album(), kind: _kind, fields: previous } as CatalogItem;
  mount(<CatalogEditConfirmation snapshot={{ item, patch: catalogPatch(item, next as CatalogItem['fields'], 'public') }} stale={false} disabled={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
  labels.forEach((label, index) => {
    const row = screen.getByRole('heading', { name: label }).closest('article')!;
    expect(within(row).getByText(values[index], { exact: true, normalizer: text => text })).toBeVisible();
  });
});
