import type { ReviewLookupResponse } from './catalogReviewLookupApi';
import { capturedCatalogReview } from './catalogReviewFixtures.testSupport';
import { pairedLookupResponse, pairingApplication, pairingEditions, pairingLookupResponse, pairingReview, reviewLookupResponse, reviewTieLookupResponse } from './catalogReviewLookupFixtures.testSupport';
import { reviewLookupBrief } from './reviewLookupBrief';

/**
 * The review page's own reading of its lookup view as a brief (the one the server sends Album completion cards; the server's test
 * runs both on the same records): each kind of run, from the shared review fixtures. All names are synthetic.
 */
type Lookup = NonNullable<ReviewLookupResponse['lookup']>;
const pairing = pairingReview(), captured = capturedCatalogReview();
const context = (item = pairing, available = true) => ({ available, members: item.draft.tracks.length, searched: item.draft.album.title,
  artists: item.draft.album.artists.filter(entry => entry.role === 'primary').map(entry => entry.name) });
const edited = (edit: Partial<Lookup>) => ({ ...reviewLookupResponse().lookup!, ...edit });

test('a possible release whose tracks pair in more than one way asks for Disc and Track Numbers and counts its editions once', () => {
  expect(reviewLookupBrief(pairingLookupResponse().lookup, context())).toEqual({ state: 'complete', outcome: 'possible', answers: 0, next: 'numbers', releases: 1 });
});

test('a possible release that pairs in one way, beside one that does not, needs a choice, not numbers', () => {
  const lookup = pairingLookupResponse().lookup!;
  const mixed = { ...lookup, candidates: lookup.candidates.map(entry => entry.key === pairingEditions[1]
    ? { ...entry, barcode: '4006381339999', comparison: { ...entry.comparison!, subset: { ...entry.comparison!.subset!, pairing: 'unique' as const } } } : entry) };
  expect(reviewLookupBrief(mixed, context())).toEqual({ state: 'complete', outcome: 'possible', answers: 0, next: 'choose', releases: 2 });
});

test('an applied release counts its open conflicts; a tie waits for a choice and counts one answer', () => {
  expect(reviewLookupBrief(reviewLookupResponse().lookup, context(captured))).toEqual({ state: 'complete', outcome: 'applied', answers: 3, next: null, releases: 0 });
  expect(reviewLookupBrief(edited({ needsAnswer: { tie: false, conflicts: ['album.title'] } }), context(captured))).toEqual({ state: 'complete', outcome: 'applied', answers: 1, next: null, releases: 0 });
  expect(reviewLookupBrief(reviewTieLookupResponse().lookup, context(captured))).toEqual({ state: 'complete', outcome: 'matched', answers: 1, next: 'choose', releases: 0 });
});

test('queued, running and retrying runs are active; a stopped run offers the free retry only where lookup runs; a superseded run or one that found lookup unconfigured offers none', () => {
  for (const state of ['queued', 'running', 'retrying'] as const) expect(reviewLookupBrief(edited({ state, applied: null, needsAnswer: { tie: false, conflicts: [] } }), context(captured)))
    .toEqual({ state, outcome: 'active', answers: 0, next: null, releases: 0 });
  const stopped = edited({ state: 'stopped', issue: 'grantExpired', applied: null, needsAnswer: { tie: false, conflicts: [] } });
  expect(reviewLookupBrief(stopped, context(captured))).toEqual({ state: 'failed', outcome: 'unavailable', answers: 0, next: 'retry', releases: 0 });
  expect(reviewLookupBrief(stopped, context(captured, false))).toEqual({ state: 'failed', outcome: 'unavailable', answers: 0, next: null, releases: 0 });
  expect(reviewLookupBrief({ ...stopped, state: 'unavailable', issue: 'notConfigured' }, context(captured))).toEqual({ state: 'failed', outcome: 'unavailable', answers: 0, next: null, releases: 0 });
  // A run superseded because the review's source was no longer current cannot be retried until it is.
  expect(reviewLookupBrief({ ...stopped, state: 'superseded', issue: 'projectClosed' }, context(captured))).toEqual({ state: 'failed', outcome: 'unavailable', answers: 0, next: null, releases: 0 });
});

test('an Album without members needs a choice among its same-name releases, and has none to choose where the run found no release', () => {
  const empty = { ...pairing, draft: { ...pairing.draft, tracks: [] } };
  const lookup = { ...pairingLookupResponse().lookup!, candidates: pairingLookupResponse().lookup!.candidates.map(candidate => ({ ...candidate, status: 'unverified' as const })) };
  expect(reviewLookupBrief(lookup, context(empty))).toEqual({ state: 'complete', outcome: 'possible', answers: 0, next: 'choose', releases: 1 });
  // No release while iTunes was unavailable besides: no match, never releases to choose from.
  expect(reviewLookupBrief({ ...lookup, outcome: 'noRelease', candidates: [], groups: [], itunes: 'unavailable' }, context(empty)))
    .toEqual({ state: 'complete', outcome: 'none', answers: 0, next: null, releases: 0 });
});

test('a release applied for its Album values only, whose pairing is now single, can be used again; without a run there is no brief', () => {
  const again = pairedLookupResponse(pairingApplication(pairingEditions[0], false)).lookup;
  expect(reviewLookupBrief(again, context())).toEqual({ state: 'complete', outcome: 'applied', answers: 0, next: 'choose', releases: 0 });
  // Used through its pairing, the release is applied; its title conflicts count only once the view lists them as needing an answer.
  const paired = pairedLookupResponse(pairingApplication(pairingEditions[0], true)).lookup!;
  expect(reviewLookupBrief(paired, context())).toEqual({ state: 'complete', outcome: 'applied', answers: 0, next: null, releases: 0 });
  expect(reviewLookupBrief({ ...paired, needsAnswer: { tie: false, conflicts: paired.applied!.conflicts.map(conflict => conflict.path) } }, context()))
    .toEqual({ state: 'complete', outcome: 'applied', answers: 2, next: null, releases: 0 });
  expect(reviewLookupBrief(null, context())).toBeNull();
});
