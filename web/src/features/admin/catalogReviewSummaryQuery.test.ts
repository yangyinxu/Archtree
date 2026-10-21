import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { catalogReview, reviewId, reviewJson, viewer } from './catalogReviewFixtures.testSupport';
import { reviewIdentityResponse, reviewLookupResponse } from './catalogReviewLookupFixtures.testSupport';
import { catalogReviewCandidatesQuery, catalogReviewKey, catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';

/**
 * The review summary's two reads on their own: their keys (the review detail's, then each read's revision), which earlier read may
 * stand in while the next loads, the paths they read, and a response the strict schemas refuse. All identifiers are synthetic.
 */
const access = { viewerId: viewer, epoch: 3, generation: 7 };
const item = { ...catalogReview(), revision: 4, valueRevision: 2 };
const signal = new AbortController().signal;
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
});
afterEach(() => { adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('both reads are keyed under the review detail\'s own key, the summary by revision and the identity rows by revision and value revision', () => {
  expect(catalogReviewKey(access, reviewId)).toEqual(['admin-catalog-reviews', viewer, 3, 7, reviewId]);
  expect(catalogReviewSummaryQuery(access, item, true).queryKey).toEqual(['admin-catalog-reviews', viewer, 3, 7, reviewId, 'lookup', 4]);
  expect(catalogReviewCandidatesQuery(access, item).queryKey).toEqual(['admin-catalog-reviews', viewer, 3, 7, reviewId, 'candidates', 4, 2]);
  for (const query of [catalogReviewSummaryQuery(access, item, true), catalogReviewCandidatesQuery(access, item)]) expect([query.retry, query.gcTime]).toEqual([false, 0]);
});

test('an earlier read stands in only for the same account, view generation, review and read; never across them, or without one', () => {
  const read = reviewLookupResponse(), summary = catalogReviewSummaryQuery(access, item, true), candidates = catalogReviewCandidatesQuery(access, item);
  const key = (extra: Partial<typeof access> = {}, id = reviewId, part = 'lookup', ...rest: unknown[]) => ({ queryKey: [...catalogReviewKey({ ...access, ...extra }, id), part, ...rest] });
  expect(summary.placeholderData(read, key({}, reviewId, 'lookup', 3))).toBe(read);
  expect(candidates.placeholderData(read, key({}, reviewId, 'candidates', 3, 1))).toBe(read);
  for (const other of [key({ viewerId: 'f'.repeat(24) }, reviewId, 'lookup', 3), key({ epoch: 4 }, reviewId, 'lookup', 3), key({ generation: 8 }, reviewId, 'lookup', 3),
    key({}, 'e'.repeat(24), 'lookup', 3), key({}, reviewId, 'candidates', 3)]) expect(summary.placeholderData(read, other)).toBeUndefined();
  expect(candidates.placeholderData(read, key({}, reviewId, 'lookup', 3))).toBeUndefined();
  expect(summary.placeholderData(undefined, undefined)).toBeUndefined();
  expect(summary.placeholderData(read, undefined)).toBeUndefined();
});

test('each read asks for its own path of this review and returns the parsed response', async () => {
  const fetch = vi.fn(async (path: string) => reviewJson(path.endsWith('/lookup') ? reviewLookupResponse() : reviewIdentityResponse()));
  vi.stubGlobal('fetch', fetch);
  const capture = adminWorkspace.capture(), current = { viewerId: capture.viewerId, epoch: capture.epoch, generation: capture.generation };
  expect(await catalogReviewSummaryQuery(current, item, true).queryFn({ signal })).toEqual(reviewLookupResponse());
  expect(await catalogReviewCandidatesQuery(current, item).queryFn({ signal })).toEqual(reviewIdentityResponse());
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([`/api/admin/v1/catalog-reviews/${reviewId}/lookup`, `/api/admin/v1/catalog-reviews/${reviewId}/candidates`]);
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
});

test('a summary or identity read this bundle cannot parse asks for a reload instead of showing part of it', async () => {
  for (const [read, body] of [['lookup', { ...reviewLookupResponse(), valueRevision: -1 }], ['lookup', { ...reviewLookupResponse(), decisions: [] }],
    ['candidates', { ...reviewIdentityResponse(), decisions: [] }]] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => reviewJson(body)));
    const query = read === 'lookup' ? catalogReviewSummaryQuery(access, item, true) : catalogReviewCandidatesQuery(access, item);
    await expect(query.queryFn({ signal })).rejects.toMatchObject({ code: 'ADMIN_RELOAD_REQUIRED' });
    expect(adminWorkspace.getSnapshot().reloadRequired).toBe(true);
    adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }); adminWorkspace.select('admin');
  }
});

test('a read after the administrator view closed is abandoned before any request', async () => {
  const fetch = vi.fn(async () => reviewJson(reviewLookupResponse())); vi.stubGlobal('fetch', fetch);
  adminWorkspace.select('user');
  await expect(catalogReviewSummaryQuery(access, item, true).queryFn({ signal })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
