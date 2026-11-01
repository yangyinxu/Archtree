import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the prepare state machine's chunk before the action bar loaded it: the bar asks for a reload in place of its
 * contents and offers nothing to press, while the rest of the page stays usable. All names and identifiers are synthetic.
 */
const controlChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewPrepareControl', () => { controlChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewStatus', () => ({ CatalogReviewStatus: () => <div id="catalog-review-status"><strong role="status">Synthetic status line</strong></div> }));
vi.mock('./CatalogReviewLookupDetails', () => ({ CatalogReviewLookupDetails: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a prepare chunk that cannot load leaves the bar asking for a reload with nothing to press, and the page stays usable', async () => {
  const item = catalogReview();
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson({ item, receipt: null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  await waitFor(() => expect(controlChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  const alert = await screen.findByText(/Reload the page to continue/);
  expect(alert).toHaveAttribute('role', 'alert');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.queryByRole('button', { name: /^Update original Album|Save draft only/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Not right?' })).getByRole('button', { name: 'Edit manually' })).toBeEnabled();
  expect(await screen.findByRole('button', { name: 'Discard completion' })).toBeEnabled();
});
