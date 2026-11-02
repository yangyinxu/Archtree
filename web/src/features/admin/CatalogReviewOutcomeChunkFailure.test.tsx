import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import type { CatalogReview } from './catalogReviewApi';
import { albumId, catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the stale and applied views' chunks before the review page loaded them: each asks for a reload in its place,
 * while the stale view's Discard completion and the action bar's link to the Album stay usable. All names and identifiers are
 * synthetic.
 */
const chunks = vi.hoisted(() => ({ stale: 0, applied: 0 }));
vi.mock('./CatalogReviewStale', () => { chunks.stale += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewApplied', () => { chunks.applied += 1; throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

/** Opens the review page on `item` and waits past React's Suspense throttle for a failed lazy child. */
async function open(item: CatalogReview, attempts: () => number) {
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson({ item, receipt: null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(attempts()).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(await screen.findByText(/Reload the page to continue/)).toHaveAttribute('role', 'alert');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
}

test('a stale view chunk that cannot load asks for a reload in its place, and Discard completion and the latest Album stay offered', async () => {
  const item = catalogReview(); item.sourceStatus = 'changed';
  await open(item, () => chunks.stale);
  expect(await screen.findByRole('button', { name: 'Discard completion' })).toBeEnabled();
  expect(within(await screen.findByRole('region', { name: 'Current step' })).getByRole('link', { name: 'View the latest original Album' })).toHaveAttribute('href', `/admin/catalog/album/${albumId}`);
});

test('an applied view chunk that cannot load asks for a reload in its place, and the bar still opens the original Album', async () => {
  const item: CatalogReview = { ...catalogReview(), state: 'applied', sourceStatus: 'changed', capabilities: { analysis: false, apply: false },
    applied: { operationId: '30000000-0000-4000-8000-000000000003', at: '2026-10-02T00:00:00.000Z', fields: [{ scope: 'album', slotId: null, field: 'title' }] } };
  await open(item, () => chunks.applied);
  expect(within(await screen.findByRole('region', { name: 'Current step' })).getByRole('link', { name: 'View original Album' })).toHaveAttribute('href', `/admin/catalog/album/${albumId}`);
});
