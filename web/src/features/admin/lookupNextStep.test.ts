import enBundle from '../../../../localization/generated/bundles/en-US.json';
import zhBundle from '../../../../localization/generated/bundles/zh-Hans.json';
import { lookupActive, lookupNextStep, lookupPollMs, reviewLookupKey, type LookupStepView } from './lookupNextStep';

/** The lookup next step both summaries share, read from views shaped as the server's allowlist returns them. */
const view = (extra: Partial<LookupStepView> = {}): LookupStepView => ({ run: 2, state: 'complete', issue: null, outcome: 'candidates', itunes: 'notQueried', candidates: [{ status: 'matching' }],
  groups: [{}], preselection: null, disclosure: null, needsAnswer: { tie: false }, applied: null, ...extra });
const applied = (extra: Partial<NonNullable<LookupStepView['applied']>> = {}) => ({ run: 2, choice: 'preselected', source: 'musicbrainz', notChecked: false, ...extra });
const step = (lookup: LookupStepView | null, available = true, uploadsWaiting = false) => lookupNextStep(lookup, { available, uploadsWaiting });

test('every next-step branch names its import status and offers the free retry only while lookup is busy, unavailable, stopped or incomplete', () => {
  const cases: [LookupStepView | null, boolean, boolean, string, boolean][] = [
    [null, false, false, 'lookup.not_configured', false], [null, true, true, 'lookup.not_run', false], [null, true, false, 'lookup.not_started', false],
    [view({ state: 'queued' }), true, false, 'lookup.active', false], [view({ state: 'running', itunes: 'running' }), true, false, 'lookup.active_itunes', false],
    [view({ state: 'retrying' }), true, false, 'lookup.retrying', true], [view({ state: 'retrying', itunes: 'retrying' }), true, false, 'lookup.retrying_itunes', true],
    [view({ state: 'unavailable', issue: 'notConfigured' }), true, false, 'lookup.not_configured', false], [view({ state: 'unavailable', issue: 'sourceUnavailable' }), true, false, 'lookup.unavailable', true],
    [view({ state: 'stopped' }), true, false, 'lookup.stopped', true], [view({ state: 'superseded' }), true, false, 'lookup.superseded', true],
    [view({ groups: [], itunes: 'unavailable' }), true, false, 'lookup.itunes_unavailable', false],
    [view({ groups: [], issue: 'sourceBusy', candidates: [{ status: 'incomplete' }] }), true, false, 'lookup.incomplete', true],
    [view({ groups: [], issue: 'sourceUnavailable' }), true, false, 'lookup.unavailable', true],
    [view({ groups: [], outcome: 'noRelease' }), true, false, 'lookup.no_release', false], [view({ groups: [], outcome: 'noQuery' }), true, false, 'lookup.no_query', false],
    [view({ groups: [{}, {}], needsAnswer: { tie: true } }), true, false, 'lookup.tie', false],
    [view({ disclosure: { partialComparison: true } }), true, false, 'lookup.single_choice', false],
    [view({ applied: applied() }), true, false, 'lookup.applied', false], [view({ applied: applied({ source: 'itunes' }) }), true, false, 'lookup.applied_itunes', false],
    [view({ applied: applied({ source: 'itunes', notChecked: true }) }), true, false, 'lookup.applied_itunes_unchecked', true],
    [view({ applied: applied({ choice: 'none' }) }), true, false, 'lookup.applied_none', false], [view(), true, false, 'lookup.applied_none', false],
    [view({ groups: [], candidates: [{ status: 'incomplete' }] }), true, false, 'lookup.incomplete', true],
    [view({ groups: [], candidates: [{ status: 'notMatching' }], applied: applied({ choice: 'none' }) }), true, false, 'lookup.applied_none', false],
    [view({ groups: [], candidates: [{ status: 'notMatching' }] }), true, false, 'lookup.no_match', false]
  ];
  for (const [lookup, available, uploads, status, retry] of cases) expect(step(lookup, available, uploads)).toEqual({ status, retry });
});

test('the free retry is never offered where this server cannot run lookup', () => {
  for (const lookup of [view({ state: 'retrying' }), view({ state: 'stopped' }), view({ state: 'unavailable', issue: 'sourceUnavailable' }), view({ groups: [], candidates: [{ status: 'incomplete' }] })])
    expect(step(lookup, false).retry).toBe(false);
});

test('a review reads its own copy for messages that name files, tags or the import, camelCase kept for the text hook, and every other key unchanged', () => {
  expect(['lookup.not_started', 'lookup.no_query', 'lookup.no_match', 'lookup.applied_none', 'lookup.tie', 'lookup.single_choice', 'lookup.superseded'].map(reviewLookupKey)).toEqual([
    'catalog_review.lookup_not_started', 'catalog_review.lookup_no_query', 'catalog_review.lookup_no_match', 'catalog_review.lookup_applied_none', 'catalog_review.lookup_tie',
    'catalog_review.lookup_single_choice', 'catalog_review.lookup_superseded']);
  expect(['lookup.status_notMatching', 'lookup.difference_tooManyTracks', 'lookup.difference_tracklistInvalid', 'lookup.difference_pairing', 'lookup.unknown_discs'].map(reviewLookupKey)).toEqual([
    'catalog_review.lookup_status_notMatching', 'catalog_review.lookup_difference_tooManyTracks', 'catalog_review.lookup_difference_tracklistInvalid',
    'catalog_review.lookup_difference_pairing', 'catalog_review.lookup_unknown_discs']);
  for (const key of ['lookup.applied', 'lookup.retrying', 'lookup.status_incomplete', 'lookup.difference_trackCount', 'lookup.barcode', 'summary.flagged']) expect(reviewLookupKey(key)).toBe(key);
});

test('a summary polls every 3 seconds while a run is active, every 10 while an outage is retried, and never offline or idle', () => {
  expect(['queued', 'running', 'retrying'].every(lookupActive)).toBe(true);
  expect(['complete', 'stopped', 'unavailable', 'superseded', undefined].some(lookupActive)).toBe(false);
  expect(lookupPollMs({ state: 'queued', issue: null }, true)).toBe(3_000);
  expect(lookupPollMs({ state: 'retrying', issue: 'sourceBusy' }, true)).toBe(3_000);
  expect(lookupPollMs({ state: 'retrying', issue: 'sourceUnavailable' }, true)).toBe(10_000);
  expect(lookupPollMs({ state: 'running', issue: null }, false)).toBe(false);
  expect(lookupPollMs({ state: 'complete', issue: null }, true)).toBe(false);
  expect(lookupPollMs(null, true)).toBe(false);
});

test('every review copy a lookup key maps to is a shipped message in both locales, worded apart from the import\'s', () => {
  const keys = ['lookup.not_started', 'lookup.no_query', 'lookup.no_match', 'lookup.applied_none', 'lookup.tie', 'lookup.single_choice', 'lookup.superseded', 'lookup.status_matching',
    'lookup.status_notMatching', 'lookup.status_unverified', 'lookup.unknown_durations', 'lookup.unknown_discs', 'lookup.partial_comparison', 'lookup.difference_pairing',
    'lookup.difference_tooManyTracks', 'lookup.difference_tracklistInvalid'];
  // As the admin text hook reads a key: under `admin.`, camelCase snake-cased.
  const shipped = (key: string) => `admin.${key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)}`;
  for (const [locale, messages] of [['en-US', enBundle.messages], ['zh-Hans', zhBundle.messages]] as const) {
    const read = messages as Record<string, string>;
    for (const key of keys) {
      const review = read[shipped(reviewLookupKey(key))];
      expect(review, `${locale} ${key}`).toEqual(expect.any(String));
      expect(review, `${locale} ${key}`).not.toBe(read[shipped(key)]);
    }
  }
});
