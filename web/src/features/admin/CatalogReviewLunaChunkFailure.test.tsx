import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the Luna AI controls' chunk before the review page loaded it: the page asks for a reload in their place, and
 * the steps, the draft editor, its save, the lookup summary and Discard completion stay usable. All names and identifiers are
 * synthetic.
 */
const lunaChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewLuna', () => { lunaChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewSummary', () => ({ CatalogReviewSummary: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a Luna AI chunk that cannot load asks for a reload in place of its controls, and the steps, editor, save, lookup summary and Discard completion stay usable', async () => {
  const item = catalogReview(), writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms); a throwing one would have replaced the page.
  await waitFor(() => expect(lunaChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  const other = screen.getByRole('region', { name: 'Other actions' });
  expect(await screen.findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(other).toContainElement(screen.getByText(/Reload the page to continue/));
  expect(screen.queryByRole('button', { name: /Luna AI/ })).not.toBeInTheDocument();
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(await screen.findByRole('group', { name: 'Completion steps' })).toBeVisible();
  expect(await screen.findByRole('button', { name: 'Discard completion' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save completion draft' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});
