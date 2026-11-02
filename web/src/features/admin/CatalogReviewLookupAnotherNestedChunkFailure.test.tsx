import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the old hashed chunk of the name box: the page asks for a reload where the box opens, under the row of
 * alternatives, whose toggle still closes it, while the status line and the rest of the page stay usable. All names and
 * identifiers are synthetic.
 */
vi.mock('./LookupBox', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a name box chunk that cannot load asks for a reload where the box opens, and its toggle and the status line stay usable', async () => {
  const item = catalogReview();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reviewJson(path.endsWith('/lookup') ? { lookup: null, revision: 1, valueRevision: 0,
    summary: { waiting: { lookup: false, analysis: false }, needsAnswer: { tie: false, conflicts: [] }, lookupAvailable: true, primaryArtists: [] } } : { item, receipt: null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}>
    <Routes><Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  // Before any run the box is the next step, so it opens by itself, and its chunk's failure asks for a reload in its place.
  const toggle = await screen.findByRole('button', { name: 'Look up another name' });
  const another = await within(document.getElementById('catalog-review-another')!).findByRole('alert');
  expect(another).toHaveTextContent(/^The administrator workbench was updated\. Reload the page to continue/);
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.getByText('Metadata lookup has not run')).toHaveAttribute('role', 'status');
  fireEvent.click(toggle);
  expect(document.getElementById('catalog-review-another')).toBeNull();
  expect(screen.getByRole('button', { name: 'Edit manually' })).toBeEnabled();
});
