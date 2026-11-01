import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { capturedCatalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';
import { reviewAfterLookup, reviewIdentityResponse, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * A deploy removed the old hashed status line chunk: the page asks for a reload in its place, and, with no next step known, offers
 * no Look up another name, while the proposals, the lookup details, the draft editor, its save and Luna AI stay usable. All names
 * and identifiers are synthetic.
 */
vi.mock('./CatalogReviewStatus', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a status line chunk that cannot load asks for a reload in its place, offers no other name to look up, and the details, editing, save and Luna AI stay usable', async () => {
  const item = reviewAfterLookup(capturedCatalogReview()), writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson(path.endsWith('/lookup') ? reviewLookupResponse() : path.endsWith('/candidates') ? reviewIdentityResponse() : { item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}>
    <Routes><Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  const reload = await screen.findByText(/^The administrator workbench was updated\. Reload the page to continue/);
  expect(reload).toHaveAttribute('role', 'alert');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  // The details below still answer, after the reload request.
  const members = await screen.findByRole('region', { name: 'Track Artists' });
  expect(reload.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Look up another name' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Luna AI/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit manually' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Save draft only' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});
