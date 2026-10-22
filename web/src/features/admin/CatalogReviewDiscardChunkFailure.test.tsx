import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { AdminWorkbenchPage } from './AdminWorkbenchPage';
import { albumId, catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy between page load and opening a review removed every old hashed chunk the tab had not loaded yet: the Discard
 * completion action is left out, while the review page (with the summary's reload request) and the queue stay usable. All names
 * and identifiers are synthetic.
 */
vi.mock('./CatalogReviewSummary', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
const discardChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewDiscard', () => { discardChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

/** Renders `route` with the review page and the workbench, the way the admin router mounts them. */
function mount(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} />
    <Route path="/admin/imports" element={<AdminWorkbenchPage />} /></Routes></MemoryRouter></QueryClientProvider>);
}
/**
 * Waits until the page tried the discard chunk and React rendered the failure, which it reveals only after its Suspense throttle
 * (about 300 ms): a lazy child that throws would have replaced the page by then.
 */
async function settle(before: number) {
  await waitFor(() => expect(discardChunk.attempts).toBeGreaterThan(before));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
}

test('a review page whose summary and discard chunks cannot load asks for a reload, and manual editing, its save and Luna AI stay usable', async () => {
  const item = catalogReview(); item.analysis = { ...item.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 }; item.suggestions = [];
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const before = discardChunk.attempts;
  mount(`/admin/catalog-reviews/${reviewId}`);
  expect(await screen.findByRole('alert')).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  await settle(before);
  expect(screen.queryByRole('button', { name: 'Discard completion' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use Luna AI (paid)' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save completion draft' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
  expect(screen.getByRole('textbox', { name: 'Title' })).toBeVisible();
});

test('the Album completions queue still shows an unfinished card and its links when the discard chunk cannot load', async () => {
  const open = { id: reviewId, revision: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedByMe: true, state: 'reviewing',
    analysis: { ...catalogReview().analysis, state: 'complete' }, albumId, title: 'Draft Album title', albumTitle: 'Catalog Album title', pendingSuggestions: 0 };
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson({ items: [open], counts: { all: 1, analyzing: 0, awaitingReview: 1, needsAttention: 0, completed: 0 }, nextCursor: null })));
  const before = discardChunk.attempts;
  mount('/admin/imports?source=catalogReviews');
  await screen.findByRole('heading', { name: 'Draft Album title' });
  await settle(before);
  const card = within(screen.getByRole('heading', { name: 'Draft Album title' }).closest('li')!);
  expect(card.getByRole('link', { name: 'Open Album completion' })).toHaveAttribute('href', `/admin/catalog-reviews/${reviewId}`);
  expect(card.getByRole('link', { name: 'Edit published Album' })).toHaveAttribute('href', `/admin/catalog/album/${albumId}`);
  expect(card.queryByRole('button', { name: 'Discard completion' })).not.toBeInTheDocument();
});
