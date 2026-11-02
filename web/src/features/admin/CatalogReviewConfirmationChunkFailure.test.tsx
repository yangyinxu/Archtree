import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the confirmation's chunk before the update was requested: the confirmation asks for a reload in its place and,
 * as nothing may be confirmed unseen, the confirm button waits with that reason, while going back still works. All names and
 * identifiers are synthetic.
 */
vi.mock('./CatalogReviewConfirmation', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewStatus', () => ({ CatalogReviewStatus: () => <div id="catalog-review-status"><strong role="status">Synthetic status line</strong></div> }));
vi.mock('./CatalogReviewLookupDetails', () => ({ CatalogReviewLookupDetails: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a confirmation chunk that cannot load asks for a reload in its place and holds the confirm button, while going back still works', async () => {
  const item = catalogReview(); item.draft.album.title = 'Saved Album correction'; const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => { if (init?.method && init.method !== 'GET') writes.push(path); return reviewJson({ item, receipt: null }); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('checkbox', { name: /^Title · Synthetic catalog Album/ }));
  const update = await screen.findByRole('button', { name: 'Update original Album (1)' });
  await waitFor(() => expect(update).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(update);
  const confirm = await screen.findByRole('button', { name: 'Confirm update (1)' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  await waitFor(() => expect(confirm).toHaveAttribute('aria-disabled', 'true'));
  expect(confirm).toHaveAccessibleDescription(/Reload the page to continue/);
  expect(screen.getAllByText(/Reload the page to continue/)[0]).toHaveAttribute('role', 'alert');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: 'Back to adjust' }));
  expect(await screen.findByRole('button', { name: 'Update original Album (1)' })).toBeInTheDocument();
  expect(writes).toEqual([]);
});
