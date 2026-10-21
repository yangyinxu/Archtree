import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { capturedCatalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';
import { reviewAfterLookup, reviewIdentityResponse, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * A deploy between page load and a lookup completing removed the old hashed chunks the lookup summary loads late (the candidate
 * chooser and the identity rows): each asks for a reload in its own place, while the rest of the summary, the draft editor and its
 * save stay usable. All names and identifiers are synthetic.
 */
vi.mock('./CandidateChooser', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewIdentities', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a candidate chooser or identity chunk that cannot load asks for a reload inside the summary, and the summary, the draft editor and its save stay usable', async () => {
  const item = reviewAfterLookup(capturedCatalogReview());
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson(path.endsWith('/lookup') ? reviewLookupResponse() : path.endsWith('/candidates') ? reviewIdentityResponse() : { item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}>
    <Routes><Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  const summary = await screen.findByRole('region', { name: 'Metadata lookup' });
  await waitFor(() => expect(within(summary).getAllByRole('alert')).toHaveLength(2));
  for (const alert of within(summary).getAllByRole('alert')) expect(alert).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  // The rest of the summary still answers: its name box, its conflicts and its member rows.
  expect(await within(summary).findByRole('group', { name: 'Look up by name' })).toBeInTheDocument();
  expect(within(summary).getByRole('region', { name: 'Track Artists' })).toBeInTheDocument();
  expect(within(summary).getAllByRole('button', { name: 'Keep current' }).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save completion draft' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});
