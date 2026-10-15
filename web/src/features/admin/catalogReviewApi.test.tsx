import { advanceAccountEpoch, captureAccountOperation } from '../../api/accountEpoch';
import { adminEndpointRequest } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import { reviewChanges, reviewDetailSchema, reviewResponseSchema } from './catalogReviewApi';
import { catalogReview, deferred, reviewJson, slotId, slotTwo, viewer } from './catalogReviewFixtures.testSupport';
import { reviewValueText } from './ImportReview';

beforeEach(() => {
  adminWorkspace.reset();
  adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true });
  adminWorkspace.select('admin');
});
afterEach(() => { vi.unstubAllGlobals(); adminWorkspace.reset(); });

test('review source mapping rejects duplicate identities, orphan draft slots and forged mutation fields', () => {
  const item = catalogReview();
  expect(reviewDetailSchema.safeParse(item).success).toBe(true);
  const malformed = [
    { ...item, source: { ...item.source, tracks: [item.source.tracks[0], item.source.tracks[0]] } },
    { ...item, source: { ...item.source, tracks: [item.source.tracks[0], { ...item.source.tracks[1], id: item.source.tracks[0].id }] } },
    { ...item, draft: { ...item.draft, tracks: [item.draft.tracks[0], { ...item.draft.tracks[1], slotId: '10000000-0000-4000-8000-000000000003' }] } },
    { ...item, draft: { ...item.draft, album: { ...item.draft.album, visibility: 'hidden' } } },
    { ...item, source: { ...item.source, tracks: [{ ...item.source.tracks[0], mediaUrl: '/api/private/media' }, item.source.tracks[1]] } },
    { ...item, suggestions: [{ ...item.suggestions[0], field: 'credits' }] },
    { ...item, suggestions: [{ ...item.suggestions[1], slotId: '/other/source' }] },
    { ...item, suggestions: [{ ...item.suggestions[0], generation: 2 }] }
  ];
  for (const value of malformed) expect(reviewDetailSchema.safeParse(value).success).toBe(false);
});

test.each(['/Users/synthetic/Music/01.mp3', '..\\01.mp3', 'C:01.mp3', '.', '..', '\ud800.mp3'])('historical naming evidence rejects a device path or unsafe basename: %s', originalFileName => {
  const item = catalogReview(); item.source.tracks[0].originalFileName = originalFileName;
  expect(reviewDetailSchema.safeParse(item).success).toBe(false);
});

test.each([
  [null, '—'],
  [{ year: 2024, month: null, day: null }, '2024'],
  [{ year: 2024, month: 2, day: null }, '2024-02'],
  [{ year: 2024, month: 2, day: 29 }, '2024-02-29']
])('review dates show only their known calendar precision', (value, text) => {
  expect(reviewValueText(value)).toBe(text);
});

test('review suggestions cannot invent folders or attach filename evidence to a slot whose filename is absent', () => {
  const item = catalogReview();
  expect(reviewDetailSchema.safeParse({ ...item, suggestions: [{ ...item.suggestions[0], source: 'folder' }] }).success).toBe(false);
  expect(reviewDetailSchema.safeParse({ ...item, suggestions: [{ ...item.suggestions[1], slotId: slotTwo }] }).success).toBe(false);
  const number = { ...item.suggestions[1], field: 'trackNumber', baseline: 1, value: 3 };
  expect(reviewDetailSchema.safeParse({ ...item, suggestions: [{ ...number, source: 'context' }] }).success).toBe(false);
  expect(reviewDetailSchema.safeParse({ ...item, suggestions: [{ ...number, slotId: slotTwo, baseline: null }] }).success).toBe(false);
  expect(reviewDetailSchema.safeParse({ ...item, suggestions: [number] }).success).toBe(true);
});

test('applied review history rejects unmapped or duplicate paths and incomplete terminal state', () => {
  const item = catalogReview(), field = { scope: 'album' as const, slotId: null, field: 'title' as const };
  const applied = { operationId: '30000000-0000-4000-8000-000000000003', at: '2026-10-02T00:00:00.000Z', fields: [field] };
  expect(reviewDetailSchema.safeParse({ ...item, state: 'applied', applied }).success).toBe(true);
  expect(reviewDetailSchema.safeParse({ ...item, state: 'applied' }).success).toBe(false);
  expect(reviewDetailSchema.safeParse({ ...item, state: 'applied', applied: { ...applied, fields: [field, field] } }).success).toBe(false);
  expect(reviewDetailSchema.safeParse({ ...item, state: 'applied', applied: { ...applied, fields: [{ scope: 'track', slotId: '10000000-0000-4000-8000-000000000003', field: 'title' }] } }).success).toBe(false);
});

test('change selection includes metadata differences only, preserving Artist identity, visibility and artwork', () => {
  const item = catalogReview();
  item.draft.album.title = 'Human Album correction';
  item.draft.album.releaseDate = { year: 2024, month: null, day: null };
  item.draft.album.artistName = 'An identity hint is not an Artist mutation';
  item.draft.album.visibility = 'hidden';
  item.draft.tracks[0].title = 'Human Track correction';
  item.draft.tracks[0].trackNumber = 3;
  const changes = reviewChanges(item);
  expect(changes.map(({ scope, slotId, field }) => ({ scope, slotId, field }))).toEqual([
    { scope: 'album', slotId: null, field: 'title' }, { scope: 'album', slotId: null, field: 'releaseDate' },
    { scope: 'track', slotId, field: 'title' }, { scope: 'track', slotId, field: 'trackNumber' }
  ]);
  expect(changes.some(value => ['artistName', 'visibility', 'coverUrl', 'credits', 'albumId'].includes(value.field))).toBe(false);
  expect(item.source.album.title).toBe('Synthetic catalog Album');
});

test('User presentation refuses review reads, and account epoch changes discard an in-flight private review', async () => {
  const pending = deferred<Response>(), fetch = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetch);
  adminWorkspace.select('user');
  await expect(adminEndpointRequest('/catalog-reviews/private', reviewResponseSchema)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  adminWorkspace.select('admin');
  const read = adminEndpointRequest(`/catalog-reviews/${catalogReview().id}`, reviewResponseSchema);
  advanceAccountEpoch();
  adminWorkspace.authorize(captureAccountOperation('bbbbbbbbbbbbbbbbbbbbbbbb'), true, true, undefined, { editing: true, visibility: true });
  adminWorkspace.select('admin'); pending.resolve(reviewJson({ item: catalogReview(), receipt: null }));
  await expect(read).rejects.toMatchObject({ status: 409, code: 'account_viewer_mismatch' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
