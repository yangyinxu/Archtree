import enBundle from '../../../../localization/generated/bundles/en-US.json';
import zhBundle from '../../../../localization/generated/bundles/zh-Hans.json';
import { lookupBriefLeads, lookupBriefMessage, lookupBriefNeedsYou, lookupBriefSchema, type LookupBrief } from './lookupBrief';

/**
 * An Album completion's lookup brief in words: the message for each outcome and next step, in both families (a card's or step's
 * state, and the Album page's whole note), whether it asks the administrator for something, and the strict schema of the server's
 * brief. Every message it names exists in both shipped bundles.
 */
const brief = (outcome: LookupBrief['outcome'], extra: Partial<LookupBrief> = {}): LookupBrief => ({ state: 'complete', outcome, answers: 0, next: null, releases: 0, ...extra });
const cases: [LookupBrief, string, Record<string, number>?][] = [
  [brief('active', { state: 'queued' }), 'queued'], [brief('active', { state: 'running' }), 'running'], [brief('active', { state: 'retrying' }), 'retrying'],
  [brief('applied'), 'applied'], [brief('applied', { answers: 3 }), 'applied_answers', { count: 3 }], [brief('applied', { next: 'choose' }), 'applied_again'],
  [brief('applied', { next: 'retry' }), 'applied_retry'], [brief('applied', { next: 'retry', answers: 2 }), 'applied_retry'], [brief('matched', { next: 'choose', answers: 1 }), 'choose'], [brief('matched'), 'not_used'],
  [brief('possible', { next: 'numbers', releases: 1 }), 'possible_numbers', { count: 1 }], [brief('possible', { next: 'choose', releases: 6 }), 'possible_choose', { count: 6 }],
  [brief('none'), 'no_match'], [brief('unavailable', { state: 'failed', next: 'retry' }), 'retry'], [brief('unavailable', { state: 'failed' }), 'unavailable']
];

test('each outcome and next step reads as its own message, in both families, and no run reads as not run', () => {
  for (const [value, name, values] of cases) {
    expect(lookupBriefMessage(value)).toEqual({ key: `catalog_review.lookup_brief_${name}`, values });
    expect(lookupBriefMessage(value, 'open_lookup')).toEqual({ key: `catalog_review.open_lookup_${name}`, values });
    for (const messages of [enBundle.messages, zhBundle.messages] as Record<string, string>[]) {
      for (const family of ['lookup_brief', 'open_lookup']) expect(typeof messages[`admin.catalog_review.${family}_${name}`], `${family}_${name}`).toBe('string');
    }
  }
  expect(lookupBriefMessage(null)).toEqual({ key: 'catalog_review.lookup_brief_not_run', values: undefined });
  expect(lookupBriefMessage(undefined)).toEqual({ key: 'catalog_review.lookup_brief_not_run', values: undefined });
});

test('the lookup asks for something while answers, a choice, numbers or the free retry wait, never while it runs or without a run', () => {
  expect([brief('applied', { answers: 1 }), brief('matched', { next: 'choose' }), brief('possible', { next: 'numbers' }), brief('unavailable', { next: 'retry' }),
    brief('applied', { next: 'retry' })].map(lookupBriefNeedsYou)).toEqual([true, true, true, true, true]);
  expect([brief('active', { state: 'running' }), brief('applied'), brief('matched'), brief('none'), brief('unavailable'), null, undefined].map(lookupBriefNeedsYou))
    .toEqual([false, false, false, false, false, false, false]);
});

test('the lookup leads while it asks for something, runs or applied a release; not after no match or none used, while unavailable or without a run', () => {
  expect([brief('applied'), brief('applied', { answers: 1 }), brief('matched', { next: 'choose' }), brief('possible', { next: 'numbers' }), brief('possible', { next: 'choose' }),
    brief('active', { state: 'running' }), brief('unavailable', { state: 'failed', next: 'retry' })].map(lookupBriefLeads)).toEqual([true, true, true, true, true, true, true]);
  expect([brief('matched'), brief('none'), brief('unavailable', { state: 'failed' }), null, undefined].map(lookupBriefLeads)).toEqual([false, false, false, false, false]);
});

test('the brief schema accepts the server\'s brief and refuses an unknown outcome, an extra key or counts out of bounds', () => {
  const value = brief('possible', { next: 'numbers', releases: 1 });
  expect(lookupBriefSchema.parse(value)).toEqual(value);
  expect(lookupBriefSchema.safeParse({ ...value, answers: 407, releases: 25 }).success).toBe(true);
  for (const wrong of [{ ...value, outcome: 'found' }, { ...value, state: 'stopped' }, { ...value, next: 'luna' }, { ...value, title: 'Synthetic' }, { ...value, answers: 408 },
    { ...value, releases: 26 }, { ...value, answers: -1 }, { ...value, answers: 1.5 }]) expect(lookupBriefSchema.safeParse(wrong).success).toBe(false);
});
