import type { ReviewLookupView } from './importLookupApi';
import { openLookupAnswers } from './catalogReviewSummaryModel';
import type { LookupBrief } from './lookupBrief';
import { lookupActive, lookupNextStep } from './lookupNextStep';
import { reviewAppliedAgain, reviewLookupFit } from './reviewLookupStatus';

/**
 * The review page's reading of its lookup view as a brief, the one the server sends Album completion cards and the Album page
 * (src/administration/lookup/catalogReviewLookupBrief.ts, which repeats it and is tested against it): the run's state, its
 * outcome, the lookup answers it waits for (as the summary counts them: the applied candidate's open conflicts and a tie), the
 * next step the review page offers and how many releases may match. Null without a run. Pure; it imports types and pure
 * modules only, so the server's test can load it.
 */
export function reviewLookupBrief(lookup: ReviewLookupView | null, context: { available: boolean; members: number; searched: string; artists: readonly string[] }): LookupBrief | null {
  if (!lookup) return null;
  const { status, retry } = lookupNextStep(lookup, { available: context.available, uploadsWaiting: false }), { answers } = openLookupAnswers(lookup);
  const active = lookupActive(lookup.state);
  const state: LookupBrief['state'] = active ? lookup.state as 'queued' | 'running' | 'retrying' : lookup.state === 'complete' ? 'complete' : 'failed';
  const brief = (outcome: LookupBrief['outcome'], next: LookupBrief['next'] = null, releases = 0): LookupBrief => ({ state, outcome, answers, next, releases });
  if (active) return brief('active');
  if (reviewAppliedAgain(lookup, status)) return brief('applied', 'choose');
  const fit = status === 'lookup.no_match' || status === 'lookup.itunes_unavailable' ? reviewLookupFit(lookup, context) : null;
  // An Album without members has releases to choose from only when the run found any.
  if (fit && (fit.members || lookup.candidates.length)) return brief('possible', fit.members && (fit.cause === 'durations' || fit.cause === 'pairing') ? 'numbers' : 'choose', fit.releases.length);
  return status === 'lookup.applied' || status === 'lookup.applied_itunes' ? brief('applied')
    : status === 'lookup.applied_itunes_unchecked' ? brief('applied', retry ? 'retry' : null)
    : status === 'lookup.tie' || status === 'lookup.single_choice' ? brief('matched', 'choose')
    : status === 'lookup.applied_none' ? brief('matched')
    : ['lookup.no_match', 'lookup.itunes_unavailable', 'lookup.no_release', 'lookup.no_query'].includes(status) ? brief('none')
    : brief('unavailable', retry ? 'retry' : null);
}
