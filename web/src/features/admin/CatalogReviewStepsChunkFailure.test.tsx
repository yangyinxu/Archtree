import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the step bar's chunk before the review page loaded it: the steps are left out, the Luna AI controls and an
 * applied completion's list of what was updated, which share that chunk, ask for a reload in their place, and the draft editor,
 * its save, the lookup summary and Discard completion stay usable. All names and identifiers are synthetic.
 */
const stepsChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewSteps', () => { stepsChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewSummary', () => ({ CatalogReviewSummary: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

/** Renders the review page for `item`, answering every read with it and every save as failed (recorded in `writes`). */
function mountPage(item: ReturnType<typeof catalogReview>, writes: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
}

test('a review page whose step bar chunk cannot load asks for a reload in place of the Luna AI controls and keeps its editor, save, lookup summary and Discard completion', async () => {
  const writes: string[] = [];
  mountPage(catalogReview(), writes);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms); a throwing one would have replaced the page.
  await waitFor(() => expect(stepsChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(screen.queryByRole('group', { name: 'Completion steps' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Luna AI/ })).not.toBeInTheDocument();
  expect(await screen.findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(await screen.findByRole('button', { name: 'Discard completion' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save completion draft' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});

test('an applied completion whose step bar chunk cannot load asks for a reload on its Update tab', async () => {
  const item = catalogReview();
  mountPage({ ...item, state: 'applied', sourceStatus: 'changed', capabilities: { analysis: false, apply: false },
    applied: { operationId: '30000000-0000-4000-8000-000000000009', at: '2026-10-22T01:30:00.000Z', fields: [{ scope: 'album', slotId: null, field: 'title' }] } });
  fireEvent.click(await screen.findByRole('tab', { name: 'Update original Album' }));
  const panel = screen.getByRole('tabpanel', { name: 'Update original Album' });
  expect(await within(panel).findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
});
