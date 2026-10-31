import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the action bar's chunk before the review page loaded it: the page asks for a reload where the bar would be,
 * while the editing section and manual editing stay readable and nothing is sent. All names and identifiers are synthetic.
 */
const barChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewActionBar', () => { barChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewSummary', () => ({ CatalogReviewSummary: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('an action bar chunk that cannot load asks for a reload in its place, and the review stays readable without sending anything', async () => {
  const item = catalogReview(), writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => { if (init?.method && init.method !== 'GET') writes.push(path); return reviewJson({ item, receipt: null }); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms); a throwing one would have replaced the page.
  await waitFor(() => expect(barChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(await screen.findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.queryByRole('region', { name: 'Current step' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Update original Album/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit manually' }));
  expect(await screen.findByRole('textbox', { name: 'Title' })).toBeEnabled();
  expect(writes).toEqual([]);
});
