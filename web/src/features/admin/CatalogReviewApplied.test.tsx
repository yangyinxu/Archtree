import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import { CatalogReviewApplied } from './CatalogReviewApplied';
import { capturedCatalogReview, catalogReview, reviewJson, session, slotTwo, viewer } from './catalogReviewFixtures.testSupport';
import { reviewAfterLookup, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * An applied Album completion's read-only Update original Album step: when the Album was updated, the fields written, the release
 * its lookup applied (read once), and nothing to select or apply. Every name and identifier is synthetic.
 */
const at = '2026-10-22T01:30:00.000Z';
const applied = (item: CatalogReview, fields: ReviewField[]): CatalogReview => ({ ...item, state: 'applied', sourceStatus: 'changed', capabilities: { analysis: false, apply: false },
  applied: { operationId: '30000000-0000-4000-8000-000000000009', at, fields } });
const fields: ReviewField[] = [{ scope: 'album', slotId: null, field: 'title' }, { scope: 'album', slotId: null, field: 'releaseDate' }, { scope: 'track', slotId: slotTwo, field: 'trackNumber' }];
function mount(item: CatalogReview) {
  const fetch = vi.fn(async (path: string) => path.endsWith('/lookup') ? reviewJson(reviewLookupResponse()) : reviewJson({ code: 'unexpected' }, 500));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><CatalogReviewApplied item={item} /></QueryClientProvider>);
  return fetch;
}
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('an applied completion lists the fields it wrote and when, in the interface language, with nothing to select or apply', () => {
  const fetch = mount(applied(catalogReview(), fields));
  expect(screen.getByRole('heading', { name: 'What was updated' })).toBeVisible();
  expect(screen.getByText(`The original Album was updated on ${new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`)).toBeVisible();
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Title', 'Release date', 'Track 2 · Track number']);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  // A completion never captured for lookup reads nothing.
  expect(fetch).not.toHaveBeenCalled();
});

test('a completion captured for lookup names the release its lookup applied, read once, and says track Artist changes are not listed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = mount(applied(reviewAfterLookup(capturedCatalogReview()), fields));
  expect(await screen.findByText('Release used in this completion: "Synthetic catalog Album (Complete)" (MusicBrainz)')).toBeVisible();
  expect(screen.getByText('Track Artist changes, if any, are not listed here.')).toBeVisible();
  await vi.advanceTimersByTimeAsync(30_000);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});

test('an apply that wrote only track Artists says so', async () => {
  mount(applied(reviewAfterLookup(capturedCatalogReview()), []));
  expect(screen.getByText('Only track Artists were updated.')).toBeVisible();
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  expect(screen.queryByText('Track Artist changes, if any, are not listed here.')).not.toBeInTheDocument();
});
