import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminCatalogReviewPage } from './AdminCatalogReviewPage';
import type { CatalogReview } from './catalogReviewApi';
import { catalogReview, reviewId, reviewJson, session, slotId, slotTwo, viewer } from './catalogReviewFixtures.testSupport';

/**
 * A deploy removed the draft editor's chunk before the review page loaded it: opening manual editing asks for a reload in its
 * place, while the proposal table, the update range and the save stay usable. All names and identifiers are synthetic.
 */
const editorChunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./CatalogReviewDraftEditor', () => { editorChunk.attempts += 1; throw new TypeError('Failed to fetch dynamically imported module'); });
vi.mock('./CatalogReviewSummary', () => ({ CatalogReviewSummary: () => <section aria-label="Metadata lookup">Synthetic lookup summary</section> }));

beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('a draft editor chunk that cannot load asks for a reload where manual editing opens, and the proposal table, update range and save stay usable', async () => {
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
  const table = await screen.findByRole('region', { name: 'Check the suggested changes' });
  const toggle = screen.getByRole('button', { name: 'Edit manually' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  await waitFor(() => expect(editorChunk.attempts).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  // The alert takes the editor's place, right after the row of alternatives.
  const alert = await screen.findByText(/Reload the page to continue/);
  expect(alert).toHaveAttribute('role', 'alert');
  expect(screen.getByRole('group', { name: 'Not right?' }).nextElementSibling).toBe(alert);
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  // The table still edits (a typed number is the administrator's own, unselected in the range), and the save sends the edit with
  // the selected proposals.
  expect(await screen.findByText(/^This update · 3 selected/)).toBeInTheDocument();
  fireEvent.change(within(table).getByRole('spinbutton', { name: 'Track number of track 2' }), { target: { value: '3' } });
  expect(await screen.findByText(/^This update · 2 selected/)).toBeInTheDocument();
  const save = await screen.findByRole('button', { name: 'Save draft only' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].changes).toEqual([{ path: `tracks.${slotId}.discNumber`, base: null, value: 1 }, { path: `tracks.${slotTwo}.discNumber`, base: null, value: 1 },
    { path: `tracks.${slotTwo}.trackNumber`, base: null, value: 3 }]);
});
