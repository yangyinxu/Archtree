import type { ReviewLookupView } from './importLookupApi';
import { pairingLookupResponse, pairingRunningTimeline, pairingTimeline } from './catalogReviewLookupFixtures.testSupport';
import { gateWaitSeconds, lookupRecord, searchedTexts } from './lookupProgressModel';

/** The pure reading of a review run's timeline: the names searched, the record and the wait since the last step. Synthetic names. */
const lookup = (extra: Partial<ReviewLookupView> = {}): ReviewLookupView => ({ ...pairingLookupResponse().lookup!, timeline: pairingTimeline(), ...extra });

test('the names searched are the done title searches whose text is shown, in order, never one the run may not have sent', () => {
  expect(searchedTexts(pairingTimeline())).toEqual([{ text: 'Synthetic Live Album 2', artist: 'Synthetic Live Artist' }, { text: 'Synthetic Live Album 2' },
    { text: 'Synthetic Live Album 2', artist: 'Synthetic Live Artist -Romanized-' }]);
  const steps = pairingTimeline().steps;
  expect(searchedTexts(pairingTimeline({ steps: [{ ...steps[0], state: 'skipped' }, { kind: 'album', state: 'done' }, steps[3], steps[2]] })))
    .toEqual([{ text: 'Synthetic Live Album 2', artist: 'Synthetic Live Artist -Romanized-' }]);
  expect(searchedTexts(pairingTimeline({ steps: [steps[0], { ...steps[1], state: 'unconfirmed' }, { ...steps[2], state: 'unconfirmed' }] })))
    .toEqual([{ text: 'Synthetic Live Album 2', artist: 'Synthetic Live Artist' }]);
});

test('the record counts whole minutes and seconds from the start to the end, else the last step, never below zero; Track titles count only once sent, and no search the run may not have sent', () => {
  expect(lookupRecord(lookup())).toEqual({ minutes: 0, seconds: 22, searches: 5, releases: 12 });
  expect(lookupRecord(lookup({ timeline: pairingTimeline({ completedAt: null, updatedAt: '2026-10-22T01:30:00.000Z' }) }))).toMatchObject({ minutes: 5, seconds: 8 });
  expect(lookupRecord(lookup({ timeline: pairingTimeline({ completedAt: '2026-10-22T01:20:00.000Z' }) }))).toMatchObject({ minutes: 0, seconds: 0 });
  expect(lookupRecord(lookup({ timeline: pairingTimeline({ trackTitleSearch: { state: 'notNeeded' } }) }))!.searches).toBe(3);
  expect(lookupRecord(lookup({ timeline: pairingRunningTimeline('2026-10-22T01:25:00.000Z'), candidates: [] }))).toEqual({ minutes: 0, seconds: 8, searches: 3, releases: 0 });
  // The search by the name alone and the second Track title may not have gone out.
  const steps = pairingTimeline().steps, titles = steps[3].texts!;
  expect(lookupRecord(lookup({ timeline: pairingTimeline({ steps: [steps[0], { ...steps[1], state: 'unconfirmed' }, steps[2], { ...steps[3], texts: titles.slice(0, 1) },
    { kind: 'trackTitle', state: 'unconfirmed', texts: titles.slice(1) }] }) }))!.searches).toBe(3);
  expect(lookupRecord({ ...lookup(), timeline: undefined })).toBeNull();
});

test('a wait shows only while a run is running and this page has seen no new step for more than five seconds of its own clock', () => {
  const seenAt = Date.parse('2026-10-22T01:25:00.000Z');
  const view = (state: ReviewLookupView['state'], updatedAt = '2026-10-22T01:25:00.000Z') => lookup({ state, timeline: pairingRunningTimeline(updatedAt) });
  expect([gateWaitSeconds(view('running'), seenAt + 5_000, seenAt), gateWaitSeconds(view('running'), seenAt + 5_001, seenAt), gateWaitSeconds(view('running'), seenAt + 12_900, seenAt)])
    .toEqual([null, 5, 12]);
  // The server's clock plays no part: a last step stamped 10 seconds ahead of this page, or a minute behind, changes nothing.
  expect([gateWaitSeconds(view('running', '2026-10-22T01:25:10.000Z'), seenAt + 4_000, seenAt), gateWaitSeconds(view('running', '2026-10-22T01:24:00.000Z'), seenAt + 4_000, seenAt),
    gateWaitSeconds(view('running', '2026-10-22T01:25:10.000Z'), seenAt + 6_000, seenAt)]).toEqual([null, null, 6]);
  expect([gateWaitSeconds(view('queued'), seenAt + 60_000, seenAt), gateWaitSeconds(view('retrying'), seenAt + 60_000, seenAt), gateWaitSeconds(view('complete'), seenAt + 60_000, seenAt),
    gateWaitSeconds({ ...view('running'), timeline: undefined }, seenAt + 60_000, seenAt)]).toEqual([null, null, null, null]);
});
