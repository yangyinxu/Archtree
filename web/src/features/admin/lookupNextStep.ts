/**
 * The metadata lookup next step an import's Review and publish summary and an existing-Album review's summary share: which status
 * the lookup view shows, whether the free retry is offered, and the lookup states both poll for. Pure; it imports types only, so
 * neither summary's chunk carries the other's schema. Owner rules: docs/business-rules.md (Administrator Metadata Lookup).
 */

/** Lookup states a summary polls for and applying or publishing waits for. */
export const lookupActive = (state: string | undefined): boolean => state === 'queued' || state === 'running' || state === 'retrying';
/** 10 s while an outage (not sourceBusy) is retried, 3 s while otherwise active; false offline or idle. */
export const lookupPollMs = (lookup: { state: string; issue: string | null } | null | undefined, online: boolean): number | false =>
  online && lookup && lookupActive(lookup.state) ? lookup.state === 'retrying' && lookup.issue !== 'sourceBusy' ? 10_000 : 3_000 : false;

/** The fields of an import's or review's lookup view the next step reads. */
export type LookupStepView = {
  run: number; state: string; issue: string | null; outcome: string | null; itunes: string;
  candidates: readonly { status: string }[]; groups: readonly unknown[]; preselection: object | null;
  disclosure: { partialComparison: boolean } | null; needsAnswer: { tie: boolean };
  applied: { run: number; choice: string; source: string; notChecked: boolean } | null;
};

/**
 * The status message key (a `lookup.*` key, with `{title}` for an applied release) and whether the free retry is offered (owner
 * rules: Administrator Metadata Lookup, next-step bullet). The retry is the only next-step button, offered while lookup is busy,
 * unavailable, stopped or superseded, or when release details or the MusicBrainz check of an applied iTunes-only result could not
 * be fetched; when nothing matches, nothing can be looked up or lookup was not configured, the name box is the next step. Luna AI
 * is never a next step. Without a run, lookup is not configured here, waits for uploads, or did not start (its trigger failed); a
 * retry or a name needs it configured, so `retry` is false wherever lookup is unavailable.
 */
export function lookupNextStep(lookup: LookupStepView | null, context: { available: boolean; uploadsWaiting: boolean }): { status: string; retry: boolean } {
  const applied = lookup?.applied, tie = Boolean(lookup?.needsAnswer.tie), available = context.available;
  // Nothing the run found matched or was applied; a completed run keeps MusicBrainz's issue when its retries ran out.
  const unmatched = !lookup?.groups.length && (applied?.run !== lookup?.run || applied?.choice === 'none');
  const musicBrainzDown = lookup?.issue === 'sourceUnavailable' || lookup?.issue === 'sourceBusy';
  const [status, retry]: [string, boolean] = !lookup ? [!available ? 'lookup.not_configured' : context.uploadsWaiting ? 'lookup.not_run' : 'lookup.not_started', false]
    : lookup.state === 'queued' || lookup.state === 'running' ? [lookup.itunes === 'running' ? 'lookup.active_itunes' : 'lookup.active', false]
    : lookup.state === 'retrying' ? [lookup.itunes === 'retrying' ? 'lookup.retrying_itunes' : 'lookup.retrying', true]
    // A run that found lookup unconfigured offers no retry: the name box is next where this server can now run lookup.
    : lookup.state === 'unavailable' ? [lookup.issue === 'notConfigured' ? 'lookup.not_configured' : 'lookup.unavailable', lookup.issue !== 'notConfigured']
    : lookup.state !== 'complete' ? [`lookup.${lookup.state}`, true]
    // MusicBrainz answered without a match and iTunes stayed unavailable: nothing matched, so the name box is next.
    : unmatched && lookup.itunes === 'unavailable' && !musicBrainzDown ? ['lookup.itunes_unavailable', false]
    // MusicBrainz stayed unavailable, so nothing is "no match": details it could not fetch are incomplete, anything else unavailable.
    : unmatched && musicBrainzDown ? [lookup.candidates.some(candidate => candidate.status === 'incomplete') ? 'lookup.incomplete' : 'lookup.unavailable', true]
    : lookup.outcome === 'noRelease' || lookup.outcome === 'noQuery' ? [lookup.outcome === 'noQuery' ? 'lookup.no_query' : 'lookup.no_release', false]
    : tie ? ['lookup.tie', false]
    // The only matching release of a partial comparison is offered, never applied unasked; it needs no answer.
    : lookup.groups.length === 1 && !lookup.preselection && lookup.disclosure?.partialComparison && applied?.run !== lookup.run ? ['lookup.single_choice', false]
    : applied?.run === lookup.run && applied.choice !== 'none' ? (applied.source !== 'itunes' ? ['lookup.applied', false]
      : applied.notChecked ? ['lookup.applied_itunes_unchecked', true] : ['lookup.applied_itunes', false])
    : lookup.groups.length ? ['lookup.applied_none', false]
    // Candidates whose details could not be fetched are no proof that nothing matches.
    : lookup.candidates.some(candidate => candidate.status === 'incomplete') ? ['lookup.incomplete', true]
    : [applied?.run === lookup.run ? 'lookup.applied_none' : 'lookup.no_match', false];
  return { status, retry: retry && available };
}

/**
 * Lookup messages whose import wording names the files, their tags or the import; an existing-Album review shows its own copy
 * (`catalog_review.lookup_<rest>`, camelCase kept so the admin text hook snake-cases it, as `lookup.<key>` is).
 */
const REVIEW_COPY: ReadonlySet<string> = new Set([
  'lookup.not_started', 'lookup.no_query', 'lookup.no_match', 'lookup.applied_none', 'lookup.tie', 'lookup.single_choice', 'lookup.superseded',
  'lookup.status_matching', 'lookup.status_notMatching', 'lookup.status_unverified', 'lookup.unknown_durations', 'lookup.unknown_discs',
  'lookup.partial_comparison', 'lookup.difference_pairing', 'lookup.difference_tooManyTracks', 'lookup.difference_tracklistInvalid'
]);
/** Review copy for lookup messages whose import wording names files, tags or the import; any other key is returned unchanged. */
export const reviewLookupKey = (key: string): string => REVIEW_COPY.has(key) ? `catalog_review.lookup_${key.slice('lookup.'.length)}` : key;
