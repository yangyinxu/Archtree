import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the review page's header chunk before the page loaded it: the plain heading with the Album title stays in its
 * place, asking for no reload, with the status line under it, and manual editing and its save stay usable. All names and identifiers
 * are synthetic.
 */
const headerChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewHeader', () => { headerChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewStatus', () => ({ CatalogReviewStatus: () => <div id="catalog-review-status"><strong role="status">Synthetic status line</strong></div> }));
vi.mock('./CatalogReviewLookupDetails', () => ({ CatalogReviewLookupDetails: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a header chunk that cannot load leaves the plain heading in its place, the status line under it, and manual editing and its save stay usable', async () => {
  const item = catalogReview(), writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  await waitFor(() => expect(headerChunk.attempts).toBeGreaterThan(0));
  expect(screen.getByRole('heading', { level: 1, name: 'Synthetic catalog Album' })).toBeVisible();
  // A loaded review's heading has no Refresh status (design v3): the status line under it polls.
  expect(screen.queryByRole('button', { name: 'Refresh status' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(screen.getByText('Synthetic status line')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('img', { name: /cover/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Reload the page to continue/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit manually' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Save draft only' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});
