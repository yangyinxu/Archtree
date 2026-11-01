import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import { CatalogReviewApplied } from './CatalogReviewApplied';
import { capturedCatalogReview, catalogReview, reviewJson, session, slotTwo, viewer } from './catalogReviewFixtures.testSupport';
import { longAlbumReview, reviewAfterLookup, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';

/**
 * An applied Album completion's outcome view: how many fields were updated with a compact row per affected Track and Album value,
 * when the Album was updated, the fields written behind a disclosure, the release its lookup applied (read once), how the edition
 * stands, and nothing to select or apply. Every name and identifier is synthetic.
 */
const at = '2026-10-22T01:30:00.000Z';
const applied = (item: CatalogReview, fields: ReviewField[]): CatalogReview => ({ ...item, state: 'applied', sourceStatus: 'changed', capabilities: { analysis: false, apply: false },
  applied: { operationId: '30000000-0000-4000-8000-000000000009', at, fields } });
const fields: ReviewField[] = [{ scope: 'album', slotId: null, field: 'title' }, { scope: 'album', slotId: null, field: 'releaseDate' }, { scope: 'track', slotId: slotTwo, field: 'trackNumber' }];
function mount(item: CatalogReview, lookup = reviewLookupResponse(), focus = false) {
  const fetch = vi.fn(async (path: string) => path.endsWith('/lookup') ? reviewJson(lookup) : reviewJson({ code: 'unexpected' }, 500));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><CatalogReviewApplied item={item} focus={focus} /></QueryClientProvider>);
  return fetch;
}
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('an applied completion counts and lists the fields it wrote and when, in the interface language, with nothing to select or apply', () => {
  const fetch = mount(applied(catalogReview(), fields));
  const heading = screen.getByRole('heading', { name: '3 fields updated' });
  // Opened applied, the view keeps the focus where it was.
  expect(heading).not.toHaveFocus();
  expect(screen.getByText(`The original Album was updated on ${new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`)).toBeVisible();
  // One compact row per affected Track and per Album value, each said updated.
  const rows = within(screen.getAllByRole('list')[0]).getAllByRole('listitem').map(item => item.textContent);
  expect(rows).toEqual(['Synthetic second trackTrack — · Updated', 'Album · TitleUpdated', 'Album · Release dateUpdated']);
  const all = screen.getByText('What was updated').closest('details')!;
  expect(within(all).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Title', 'Release date', '"Synthetic second track" · Track number']);
  // Without a lookup, nothing matched the edition.
  expect(screen.getByText('The edition remains unconfirmed.')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  // A completion never captured for lookup reads nothing.
  expect(fetch).not.toHaveBeenCalled();
});

test('a completion captured for lookup names the release its lookup applied, read once, says its edition matched and that track Artist changes are not listed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = mount(applied(reviewAfterLookup(capturedCatalogReview()), fields), reviewLookupResponse(), true);
  // Reached by this page's update, the heading takes the focus.
  await waitFor(() => expect(screen.getByRole('heading', { name: '3 fields updated' })).toHaveFocus());
  expect(await screen.findByText('Release used in this completion: "Synthetic catalog Album (Complete)" (MusicBrainz)')).toBeVisible();
  // Lookup preselected it on a match, with nothing left unchecked.
  expect(screen.getByText('Edition matched: "Synthetic catalog Album (Complete)".')).toBeVisible();
  expect(screen.getByText('Track Artist changes, if any, are not in this list; check them on the original Album\'s tracks.')).toBeVisible();
  await vi.advanceTimersByTimeAsync(30_000);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});

test.each([
  ['a release chosen without a match', { choice: 'chosen', basis: 'chosen' }, 'The edition remains unconfirmed; "Synthetic catalog Album (Complete)" was chosen without a match.'],
  ['a preselection MusicBrainz could not rule out', { notChecked: true }, 'The edition remains unconfirmed.'],
  ['no release used', { choice: 'none', candidateKey: null, releaseId: null, basis: null }, 'The edition remains unconfirmed.']
] as const)('the edition stays unconfirmed for %s', async (_case, change, line) => {
  const lookup = reviewLookupResponse();
  lookup.lookup!.applied = { ...lookup.lookup!.applied!, ...change } as NonNullable<NonNullable<typeof lookup.lookup>['applied']>;
  mount(applied(reviewAfterLookup(capturedCatalogReview()), fields), lookup);
  expect(await screen.findByText(line)).toBeVisible();
  expect(screen.queryByText(/^Edition matched/)).not.toBeInTheDocument();
});

test('an apply that wrote only track Artists says so', async () => {
  mount(applied(reviewAfterLookup(capturedCatalogReview()), []));
  expect(screen.getByText('Only track Artists were updated.')).toBeVisible();
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  expect(screen.queryByText('Track Artist changes, if any, are not in this list; check them on the original Album\'s tracks.')).not.toBeInTheDocument();
});

test('on a 44-track Album the numbers and titles written are one line each, as the confirmation grouped them', async () => {
  const long = longAlbumReview();
  long.draft.tracks = long.draft.tracks.map((track, index) => ({ ...track, discNumber: index < 15 ? 1 : index < 30 ? 2 : 3, trackNumber: index < 15 ? index + 1 : index < 30 ? index - 14 : index - 29,
    title: track.title.replace(/^\d\.\d\d\./, '') }));
  const written: ReviewField[] = long.draft.tracks.flatMap(track => (['discNumber', 'trackNumber', 'title'] as const).map(field => ({ scope: 'track' as const, slotId: track.slotId, field })));
  mount(applied(long, written), { ...reviewLookupResponse(), lookup: null });
  expect(screen.getByRole('heading', { name: '132 fields updated' })).toBeVisible();
  expect(within(screen.getAllByRole('list')[0]).getAllByRole('listitem').map(item => item.textContent))
    .toEqual(['Disc and Track Numbers of 44 tracks updated', 'Titles of 44 tracks updated']);
  // Behind the disclosure, each field written, a track by its new title.
  const all = screen.getByText('What was updated').closest('details')!;
  expect(within(all).getAllByRole('listitem')).toHaveLength(132);
  expect(within(all).getAllByRole('listitem')[2]).toHaveTextContent('"Synthetic long song 1" · Title');
  expect(await screen.findByText('The edition remains unconfirmed.')).toBeVisible();
});
