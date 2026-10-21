import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import { catalogReview, reviewId, reviewJson, session, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy between page load and opening a review removed the old hashed lookup summary chunk: the page asks for a reload in the
 * summary's place, while the draft editor, its save and Luna AI stay usable. All names and identifiers are synthetic.
 */
vi.mock('./CatalogReviewSummary', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a lookup summary chunk that cannot load asks for a reload in its place, and manual editing, its save and Luna AI stay usable', async () => {
  const item = catalogReview(); item.analysis = { ...item.analysis, state: 'idle', generation: 0, operationId: null, completedChunks: 0, totalChunks: 0, attemptsUsed: 0 }; item.suggestions = [];
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { writes.push(path); return reviewJson({ code: 'unexpected' }, 500); }
    return reviewJson({ item, receipt: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/admin/catalog-reviews/${reviewId}`]}>
    <Routes><Route path="/admin/catalog-reviews/:reviewId" element={<AdminCatalogReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('The administrator workbench was updated. Reload the page to continue');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  expect(screen.getByRole('button', { name: 'Use Luna AI (paid)' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'A manual correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save completion draft' }));
  await waitFor(() => expect(writes).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}`]));
});
