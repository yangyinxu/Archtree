import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * The page's bottom scroll padding follows the action bar actually shown: the placeholder while the prepare state machine's chunk
 * loads (slowly, as on a first visit), then the bar itself, whose later growth (an alert, a wrapped reason) keeps a focused field
 * clear of it, with 12px more for a focus outline. All names and identifiers are synthetic.
 */
const chunk = vi.hoisted(() => { let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); return { gate, release }; });
vi.mock('./CatalogReviewPrepareControl', async importOriginal => { await chunk.gate; return importOriginal(); });
vi.mock('./CatalogReviewSummary', () => ({ CatalogReviewSummary: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

/** A ResizeObserver stand-in that records what it observes and reports a resize on demand. */
class Observer {
  static all: Observer[] = [];
  observed = new Set<Element>();
  constructor(readonly report: () => void) { Observer.all.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
}

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
  Observer.all = []; vi.stubGlobal('ResizeObserver', Observer);
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('with a slow state-machine chunk, the scroll padding follows the placeholder, then the bar shown, as it grows', async () => {
  const item = catalogReview();
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson({ item, receipt: null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Synthetic lookup summary')).toBeVisible();
  // The placeholder is observed while the chunk loads.
  await waitFor(() => expect(Observer.all.some(observer => observer.observed.size > 0)).toBe(true));
  expect(document.getElementById('catalog-review-bar')).toBeNull();
  await act(async () => { chunk.release(); await chunk.gate; });
  const bar = await screen.findByRole('region', { name: 'Current step' });
  expect(bar.id).toBe('catalog-review-bar');
  // Only the bar shown is observed now, and its growth moves the padding.
  await waitFor(() => expect(Observer.all.filter(observer => observer.observed.size > 0).map(observer => [...observer.observed])).toEqual([[bar]]));
  Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: 132 });
  act(() => Observer.all.find(observer => observer.observed.has(bar))!.report());
  expect(document.documentElement.style.scrollPaddingBottom).toBe('144px');
  cleanup();
  expect(document.documentElement.style.scrollPaddingBottom).toBe('');
});

test('inside the shell, the padding goes on its main element, the container that scrolls, and the document keeps none', async () => {
  const item = catalogReview();
  vi.stubGlobal('fetch', vi.fn(async () => reviewJson({ item, receipt: null })));
  chunk.release();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}><main data-testid="shell-main"><Routes>
    <Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></main></MemoryRouter></QueryClientProvider>);
  const bar = await screen.findByRole('region', { name: 'Current step' });
  await waitFor(() => expect(Observer.all.filter(observer => observer.observed.size > 0).map(observer => [...observer.observed])).toEqual([[bar]]));
  Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: 88 });
  act(() => Observer.all.find(observer => observer.observed.has(bar))!.report());
  const main = screen.getByTestId('shell-main');
  expect(main.style.scrollPaddingBottom).toBe('100px');
  expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  cleanup();
  expect(main.style.scrollPaddingBottom).toBe('');
});
