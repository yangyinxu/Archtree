import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import type { CatalogReview } from './catalogReviewApi';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the proposal table's and the update range's chunks before the review page loaded them: each asks for a reload in
 * its place, nothing is proposed, and manual editing and its save stay usable, saving the edits alone. All names and identifiers
 * are synthetic.
 */
const chunks = vi.hoisted(() => ({ table: 0, range: 0 }));
vi.mock('./CatalogReviewProposalTable', () => { chunks.table += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewRange', () => { chunks.range += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewStatus', () => ({ CatalogReviewStatus: () => <div id="catalog-review-status"><strong role="status">Synthetic status line</strong></div> }));
vi.mock('./CatalogReviewLookupDetails', () => ({ CatalogReviewLookupDetails: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('proposal table and update range chunks that cannot load ask for a reload in their places, and manual editing saves the edits alone', async () => {
  // Captured titles that would propose Disc Numbers, were the table there.
  const titles = ['1-01 Synthetic first', '1-02 Synthetic second'], base = catalogReview();
  const item: CatalogReview = { ...base, source: { ...base.source, tracks: base.source.tracks.map((track, index) => ({ ...track, title: titles[index] })) },
    draft: { ...base.draft, tracks: base.draft.tracks.map((track, index) => ({ ...track, title: titles[index] })) } };
  const writes: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  await waitFor(() => expect([chunks.table, chunks.range].every(count => count > 0)).toBe(true));
  // React reveals a failed lazy child only after its Suspense throttle (about 300 ms).
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(await screen.findAllByText(/Reload the page to continue/)).toHaveLength(2);
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.queryByRole('region', { name: 'Check the suggested changes' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save draft only' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit manually' }));
  // Nothing is proposed, so the editor shows the saved numbers.
  expect(await screen.findByRole('spinbutton', { name: '2 · Track number' })).toHaveValue(null);
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Save draft only' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].changes).toEqual([{ path: 'album.title', base: 'Synthetic catalog Album', value: 'A manual correction' }]);
});
