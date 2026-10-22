import enBundle from '../../../../localization/generated/bundles/en-US.json';
import zhBundle from '../../../../localization/generated/bundles/zh-Hans.json';

/**
 * The shipped Luna AI wording (owner rules: Administrator Album Imports, Luna labels): every control that starts or confirms
 * Luna names Luna AI and says it is paid, status text about Luna work names Luna AI, lookup prose offers the free step before
 * paid Luna AI, and metadata lookup controls never mention AI. Both generated bundles are checked, as iOS and Android download them.
 */
const locales = { 'en-US': enBundle.messages, 'zh-Hans': zhBundle.messages } as Record<string, Record<string, string>>;
const paid: Record<string, RegExp> = { 'en-US': /\bpaid\b/, 'zh-Hans': /付费/ };
const starts = ['admin.action.analyze', 'admin.action.reanalyze', 'admin.analysis.start', 'admin.analysis.reanalyze', 'admin.lookup.luna',
  'admin.catalog_review.analysis_confirm', 'admin.catalog_review.analysis_again', 'admin.analysis.confirm_action', 'admin.analysis.confirm_title',
  'admin.catalog_review.analysis_confirm_title'];
const shipped = Object.keys(enBundle.messages);
/** The keys of a family, read from the shipped bundle so that a key added to it later is checked too. */
const family = (prefix: string, except: string[] = []) => shipped.filter(key => key.startsWith(prefix) && !except.includes(key));
// The apply button and the help text beside the Luna AI suggestions start nothing and sit under a legend that names Luna AI, so
// they keep their wording.
const suggestionControls = ['admin.summary.luna_apply', 'admin.summary.luna_help'];
const status = [...family('admin.analysis.'),
  ...['provider_unavailable', 'provider_rejected', 'provider_invalid_response', 'provider_outcome_unknown', 'grant_expired', 'permission_lost', 'budget_exhausted'].map(issue => `admin.issue.${issue}`),
  'admin.review.baseline', 'admin.review.changed', 'admin.review.conflict', 'admin.review.suggested',
  ...family('admin.summary.luna', suggestionControls), 'admin.summary.waiting_analysis', 'admin.stage.analysis',
  ...family('admin.workbench.').filter(key => key.includes('analyzing')), 'admin.workbench.review_stage',
  ...['analysis_limit', 'analysis_running', 'empty_attention', 'empty_cancelled', 'empty_no_suggestions'].map(copy => `admin.catalog_review.${copy}`)];
const lookupProse = [...['incomplete', 'itunes_unavailable', 'no_match', 'no_query', 'no_release', 'not_configured', 'not_started', 'stopped', 'unavailable'].map(state => `admin.lookup.${state}`),
  'admin.common.lookup_unavailable', ...['not_started', 'no_query', 'no_match'].map(state => `admin.catalog_review.lookup_${state}`)];
const lookupControls = [...['retry', 'submit', 'box', 'name', 'kind_album', 'kind_song', 'choose', 'choose_none'].map(control => `admin.lookup.${control}`),
  'admin.summary.keep_mine', 'admin.summary.use_lookup',
  ...['keep_current', 'use_musicbrainz', 'use_itunes', 'keep_all_current', 'use_all_musicbrainz', 'use_all_itunes', 'create'].map(control => `admin.catalog_review.${control}`)];
const generic = ['Analyze', 'Analyze again', 'Review', 'Proofread', 'Complete', '分析', '校对', '重新校对', '补全'];
/** Every [locale, key, message] for the keys, in both shipped locales. */
const each = (keys: string[]) => Object.entries(locales).flatMap(([locale, messages]) => keys.map(key => [locale, key, messages[key]] as const));

test('every listed key exists in both shipped locales, and each family read by prefix is complete', () => {
  for (const [locale, key, message] of each([...starts, ...status, ...lookupProse, ...lookupControls, ...suggestionControls])) expect(typeof message, `${locale} ${key}`).toBe('string');
  expect(family('admin.analysis.')).toEqual(expect.arrayContaining(['admin.analysis.start', 'admin.analysis.reanalyze', 'admin.analysis.confirm_title', 'admin.analysis.confirm_action',
    'admin.analysis.stop', 'admin.analysis.unavailable', 'admin.analysis.budget_project', 'admin.analysis.budget_daily', 'admin.analysis.confirm']));
  expect(family('admin.summary.luna', suggestionControls)).toEqual(expect.arrayContaining(['admin.summary.luna', 'admin.summary.luna_mark']));
  expect(status).toEqual(expect.arrayContaining(['admin.workbench.analyzing', 'admin.workbench.review_analyzing']));
});

test('every control that starts or confirms Luna names Luna AI and says it is paid in every shipped locale, never with a generic label alone', () => {
  for (const [locale, key, message] of each(starts)) {
    expect(message, `${locale} ${key}`).toMatch(/Luna AI/);
    expect(message, `${locale} ${key}`).toMatch(paid[locale]);
    expect(generic, `${locale} ${key}`).not.toContain(message);
  }
});

test('both Luna AI confirmations describe it as a paid AI service', () => {
  for (const [locale, key, message] of each(['admin.analysis.confirm', 'admin.catalog_review.analysis_copy'])) expect(message, `${locale} ${key}`).toMatch(paid[locale]);
});

test('status text about Luna work names Luna AI', () => {
  for (const [locale, key, message] of each(status)) expect(message, `${locale} ${key}`).toMatch(/Luna AI/);
});

test('every message that mentions Luna calls it Luna AI', () => {
  for (const [locale, messages] of Object.entries(locales))
    for (const [key, message] of Object.entries(messages)) expect(message, `${locale} ${key}`).not.toMatch(/Luna(?! AI)/);
});

test('lookup status text lists the free step first and ends with paid Luna AI', () => {
  const ending: Record<string, string> = { 'en-US': 'use Luna AI (paid).', 'zh-Hans': '使用 Luna AI 补全（付费）。' };
  for (const [locale, key, message] of each(lookupProse)) {
    expect(message.endsWith(ending[locale]), `${locale} ${key}: ${message}`).toBe(true);
    // Luna AI is named once, at the end, after every free step.
    expect(message.indexOf('Luna'), `${locale} ${key}`).toBe(message.length - ending[locale].length + ending[locale].indexOf('Luna'));
  }
});

test('metadata lookup controls never mention AI or Luna', () => {
  const mentions: Record<string, RegExp> = { 'en-US': /\bAI\b|Luna/, 'zh-Hans': /AI|Luna/ };
  for (const [locale, key, message] of each(lookupControls)) expect(message, `${locale} ${key}`).not.toMatch(mentions[locale]);
});

test('the Album page\'s lookup entry names MusicBrainz and says it is free, and its confirmation says Luna AI (paid) never starts', () => {
  const free: Record<string, RegExp> = { 'en-US': /\bfree\b/, 'zh-Hans': /免费/ };
  for (const [locale, key, message] of each(['admin.catalog_review.create'])) {
    expect(message, `${locale} ${key}`).toMatch(/MusicBrainz/);
    expect(message, `${locale} ${key}`).toMatch(free[locale]);
  }
  for (const [locale, key, message] of each(['admin.catalog_review.create_copy'])) {
    expect(message, `${locale} ${key}`).toMatch(/MusicBrainz/);
    expect(message, `${locale} ${key}`).toMatch(/Luna AI/);
    expect(message, `${locale} ${key}`).toMatch(paid[locale]);
  }
});
