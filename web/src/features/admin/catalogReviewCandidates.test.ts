import { reviewRowCandidates } from './catalogReviewCandidates';
import type { ReviewCandidate } from './catalogReviewLookupApi';

/** The review identity rows' candidate matching, which mirrors the import's. All names and identifiers are synthetic. */
const holderId = '00000000-0000-4000-8000-0000000000a1';
const candidate = (kind: ReviewCandidate['kind'], label: string, extra: Partial<ReviewCandidate> = {}): ReviewCandidate => ({ kind, id: 'a'.repeat(18) + '123456', label,
  revision: 'c'.repeat(64), albumId: null, visibility: 'public', match: 'name', matchedSlotIds: [], automaticReuse: false, ...extra });

test('a row\'s candidates match its kind by folded name, the MusicBrainz ID it carries, a name found for that ID or a localized name', () => {
  const items = [candidate('artist', 'LOREM'), candidate('organization', 'Lorem'), candidate('artist', 'Other', { match: 'musicBrainzId', musicBrainzId: holderId }),
    candidate('artist', 'Alias', { match: 'alias', aliasOf: holderId }), candidate('artist', 'Localized Lorem', { match: 'localizedName', localizedOf: 'lorem' }), candidate('artist', 'Unrelated')];
  expect(reviewRowCandidates('artist', 'Lorem', holderId, items).map(item => item.label)).toEqual(['LOREM', 'Other', 'Alias', 'Localized Lorem']);
  expect(reviewRowCandidates('artist', 'Lorem', null, items).map(item => item.label)).toEqual(['LOREM', 'Localized Lorem']);
  expect(reviewRowCandidates('organization', 'lorem', null, items).map(item => item.kind)).toEqual(['organization']);
});
