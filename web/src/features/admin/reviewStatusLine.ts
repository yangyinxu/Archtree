/**
 * The existing-Album review page's one status line (CatalogReviewStatus.tsx, design v3): a short headline, one sentence and the
 * lines its Details log starts with, read from the lookup view and the shared next step (lookupNextStep.ts). Owner rules:
 * docs/business-rules.md (Administrator Metadata Lookup, next-step bullet): the sentence names the next step, the free retry where
 * the shared step offers it and the name box where nothing was found or the numbers cannot be proposed; Luna AI is never a next
 * step, and while it runs (alone or beside the lookup) the headline says so. Pure; only the status line's chunk imports it.
 */
import type { ReviewLookupView } from './importLookupApi';
import { lookupActive } from './lookupNextStep';
import { reviewAppliedAgain, reviewLookupFit, reviewReleaseCount, type Message, type TitleNumbers } from './reviewLookupStatus';

/**
 * The line: its icon (`tone`), its headline (the polite status), its sentence, the lines its Details log starts with (the time an
 * active run has waited or run and that it keeps running after the page is left, as they move with every read), and whether the
 * name box is the next step (`box`).
 */
export type StatusLine = { tone: 'check' | 'clock' | 'alert' | 'search'; head: Message; line: Message | null; notes: Message[]; box: boolean };

const cr = (key: string, values?: Message['values']): Message => ({ key: `catalog_review.${key}`, values });
/** "m:ss" of a duration, minutes not wrapped at an hour, never below 0:00. */
export const elapsedText = (ms: number) => { const seconds = Math.floor(Math.max(0, ms) / 1000) || 0; return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
/** The message key of a progress phase, which the status line formats into its running headline. */
export const progressPhaseKey = (phase: string) => `catalog_review.lookup_phase_${phase}`;

type Context = { status: string; luna: boolean; members: number; searched: string; artists: readonly string[]; numbers: TitleNumbers | null; now: number;
  time?: (at: string) => string };

/**
 * The lookup's own line, the first that applies. An active run names its phase and counts (its time counts from its start to the
 * later of the last read and its last step, so a client clock behind the server's still counts); a run that failed (retrying with
 * when and which retry, MusicBrainz's retries run out, stopped for lost access or time, or superseded) says the lookup has not
 * finished; a completed run names how many possible releases it found (reviewLookupStatus.ts, `reviewReleaseCount`), and, where
 * nothing matched, why no edition is confirmed: an Album without tracks, members without a duration or a pairing that is not
 * single (checking the numbers the titles propose is next where they give every member a Disc and Track Number, else the name box),
 * or a single pairing a release's unknown duration left unconfirmed (using it is next).
 */
function lookupLine(lookup: ReviewLookupView | null, c: Context): StatusLine {
  const { status } = c, state = lookup?.state, issue = lookup?.issue, line = (tone: StatusLine['tone'], head: Message, sentence: Message | null, box = false): StatusLine =>
    ({ tone, head, line: sentence, notes: [], box });
  const failed = cr('lookup_head_failed');
  if (lookup && (state === 'queued' || state === 'running')) {
    const progress = lookup.progress, elapsed = progress && elapsedText(Math.max(c.now, Date.parse(progress.updatedAt) || 0) - Date.parse(progress.startedAt));
    const head = !progress ? { key: status } : state === 'queued' ? cr('lookup_queued_status')
      : cr(progress.total ? 'lookup_running_count_status' : 'lookup_running_status', { phase: progress.phase, done: progress.done, total: progress.total });
    return { ...line('clock', head, cr('lookup_line_running')), notes: [...(elapsed ? [cr(state === 'queued' ? 'lookup_waited' : 'lookup_elapsed', { elapsed })] : []), cr('lookup_keeps_running')] };
  }
  if (lookup && state === 'retrying') {
    const retry = lookup.timeline?.retry;
    return line('alert', failed, retry ? cr(`lookup_retry_${issue === 'sourceUnavailable' ? 'unavailable' : 'busy'}`, { source: retry.source === 'itunes' ? 'iTunes' : 'MusicBrainz',
      time: c.time ? c.time(retry.at) : retry.at, attempt: retry.attempt, limit: retry.limit }) : { key: status });
  }
  if (status === 'lookup.unavailable' && (issue === 'sourceBusy' || issue === 'sourceUnavailable')) return line('alert', failed, cr(`lookup_exhausted_${issue === 'sourceBusy' ? 'busy' : 'unavailable'}`));
  if (state === 'stopped' && (issue === 'permissionLost' || issue === 'grantExpired')) return line('alert', failed, cr(`lookup_stopped_${issue === 'grantExpired' ? 'time' : 'permission'}`));
  if (['lookup.unavailable', 'lookup.incomplete', 'lookup.stopped'].includes(status)) return line('alert', failed, cr('lookup_line_failed'));
  if (status === 'lookup.superseded') return line('alert', failed, cr('lookup_superseded'), true);
  if (status === 'lookup.not_configured') return line('search', cr('lookup_head_none'), { key: status });
  if (!lookup) return line('search', cr('lookup_head_none'), cr('lookup_line_empty'), true);
  const count = reviewReleaseCount(lookup, c.searched, c.artists), complete = cr('lookup_head_complete', { count });
  if (status === 'lookup.no_match' || status === 'lookup.itunes_unavailable') {
    const fit = reviewLookupFit(lookup, c);
    if (fit && !fit.members) return line('check', complete, cr('lookup_line_no_tracks'), true);
    if (fit) {
      const unknown = fit.unknown;
      if (fit.cause === 'durations' || fit.cause === 'pairing') return c.numbers?.disc && c.numbers.count ? line('check', complete, cr('lookup_line_numbers', { unknown }))
        : line('check', complete, cr('lookup_line_name', { unknown }), true);
      return line('check', complete, cr('lookup_line_use', { unknown }));
    }
  }
  if (['lookup.no_match', 'lookup.no_release', 'lookup.no_query', 'lookup.itunes_unavailable'].includes(status)) return line('search', cr('lookup_head_empty'), cr('lookup_line_empty'), true);
  if (status === 'lookup.tie') return line('check', complete, cr('lookup_tie'));
  if (status === 'lookup.single_choice') return line('check', complete, cr('lookup_single_choice'));
  if (status === 'lookup.applied_none') return line('check', complete, cr('lookup_applied_none'));
  const title = lookup.candidates.find(candidate => candidate.key === lookup.applied?.candidateKey)?.title ?? '—';
  if (status === 'lookup.applied') {
    const unknown = lookup.disclosure?.unknownLocalDurations ?? 0;
    return line('check', { key: status, values: { title } }, reviewAppliedAgain(lookup, status) ? cr('lookup_line_again') : unknown ? cr('lookup_line_unverified', { count: unknown }) : null);
  }
  return line(status === 'lookup.applied_itunes_unchecked' ? 'alert' : 'check', { key: status, values: { title } }, null);
}

/**
 * The status line: the lookup's own, or, while Luna AI runs, Luna AI's headline and sentence in its place (beside a running lookup,
 * both), which keep the lookup's log lines and, with Luna AI alone, whether the name box is the next step.
 */
export function reviewStatusLine(lookup: ReviewLookupView | null, c: Context): StatusLine {
  const own = lookupLine(lookup, c);
  if (!c.luna) return own;
  return lookupActive(lookup?.state) ? { ...own, tone: 'clock', head: cr('status_both_running'), line: cr('status_both_line'), box: false }
    : { ...own, tone: 'clock', head: cr('status_luna'), line: cr('status_luna_line') };
}
