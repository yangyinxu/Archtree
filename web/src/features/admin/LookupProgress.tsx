import { useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminText } from './AdminAccess';
import type { ReviewLookupView } from './importLookupApi';
import { gateWaitSeconds, lookupRecord, searchedTexts, titleSearch } from './lookupProgressModel';
import styles from './adminStyles';

type Timeline = NonNullable<ReviewLookupView['timeline']>;
type Step = Timeline['steps'][number];
type Text = NonNullable<Step['texts']>[number];
/** The stages whose counts name their own unit. */
const STAGES: readonly string[] = ['details', 'itunes', 'bridge', 'aliases'];

/**
 * The steps of an existing-Album review's lookup run (its own lazy chunk, review only; when it cannot load, the summary renders
 * nothing in its place, or asks for a reload where it would carry the Album link). While a run is queued, running or retrying: its
 * steps in order with what each searched, their states and counts (each stage naming what it counts, the bridge also the titles
 * it found), and while a running run has shown no new step for more than five seconds of this page's clock (`now`, the summary's
 * last read), that it waits for MusicBrainz (iTunes in the iTunes phase). After a run that completed with no issue: the names it
 * searched, then its record (time taken, the MusicBrainz name searches and iTunes searches sent, and
 * releases found); any other ended run, also one that completed after MusicBrainz's retries ran out, shows its steps the same way
 * without the names. A search the run may not have sent reads as such and is never named or counted. An iTunes step that left
 * results out of the comparison, and a bridge step naming the titles iTunes returned, add a line saying so. With `albumHref` (a run
 * that ended because the Album changed) the link to open the Album and start a new completion comes first, also without a
 * timeline. The list is no live region, as every poll changes it.
 *
 * It renders inside the summary's status row (`styles.statusRow`, which puts each block on its own line), which the summary keeps
 * mounted with its own status line first (the summary's live region, so it never remounts as a run appears or this chunk loads):
 * where the run has a timeline, a Details / Hide details button beside that line, then the rest as a block on the row's full width. The button shows or hides the steps (with the wait
 * note) or, after a run, its record and steps. They start shown while a run is active or after one that failed (unavailable or stopped) and hidden after
 * one that completed or was superseded; the administrator's choice holds until the run or that state changes. Hidden steps stay
 * mounted, so the wait keeps counting from when this page first saw the last step. The names searched and the Album link stay in view.
 */
export function LookupProgress({ lookup, now, albumHref }: { lookup: ReviewLookupView; now: number; albumHref: string | null }) {
  const t = useAdminText(), { locale } = useLocalization(), id = useId(), timeline = lookup.timeline;
  // When this page first saw the run's current last step, on its own clock.
  const seen = useRef<{ at: string; since: number } | null>(null);
  if (timeline && seen.current?.at !== timeline.updatedAt) seen.current = { at: timeline.updatedAt, since: now };
  const link = albumHref && <div className={styles.actions}><Link className={`${styles.link} ${styles.primary}`} to={albumHref}>{t('catalog_review.lookup_superseded_open')}</Link></div>;
  const active = lookup.state === 'queued' || lookup.state === 'running' || lookup.state === 'retrying';
  // The administrator's Details choice, for this run in this state (an active run's states count as one).
  const shown = `${lookup.run}:${active ? 'active' : lookup.state}`, [choice, setChoice] = useState<{ shown: string; open: boolean } | null>(null);
  const open = choice?.shown === shown ? choice.open : active || lookup.state === 'unavailable' || lookup.state === 'stopped';
  const button = timeline && <button className={styles.button} type="button" style={{ whiteSpace: 'nowrap' }} aria-expanded={open} aria-controls={`${id}-log`}
    onClick={() => setChoice({ shown, open: !open })}>{t(open ? 'catalog_review.lookup_log_hide' : 'catalog_review.lookup_log_show')}</button>;
  // What follows the status and its button is a block, which the status row lays out on its full width.
  const below = (body: ReactNode) => <div>{body}</div>;
  if (!timeline) return link ? below(link) : null;
  const search = timeline.trackTitleSearch;
  const quote = (entry: Text) => t(entry.artist ? 'catalog_review.lookup_step_quoted_artist' : 'catalog_review.lookup_step_quoted', { text: entry.text, artist: entry.artist ?? '' });
  const titles = (step: Step) => new Intl.ListFormat(locale, { type: 'conjunction' }).format((step.texts ?? []).map(quote));
  const label = (step: Step) => step.kind === 'trackTitle' ? search?.state === 'skipped' ? t('catalog_review.lookup_step_track_title_skipped', { reason: search.reason })
      : search?.state === 'notNeeded' ? t('catalog_review.lookup_step_track_title_not_needed')
      : step.texts?.length ? t('catalog_review.lookup_step_track_title', { titles: titles(step) }) : t('catalog_review.lookup_step_track_title_plain')
    : step.kind === 'itunes' && step.state === 'skipped' ? t('catalog_review.lookup_step_itunes_skipped', { reason: lookup.itunes === 'unavailable' ? 'unavailable' : 'notNeeded' })
    : step.kind === 'bridge' && step.texts?.length ? t('catalog_review.lookup_step_bridge_titles', { titles: titles(step) })
    : !titleSearch(step) ? t(`catalog_review.lookup_step_${step.kind}`)
    : step.texts?.length ? t(`catalog_review.lookup_step_${step.kind}`, { text: step.texts[0].text, artist: step.texts[0].artist ?? '' }) : t('catalog_review.lookup_step_search');
  // A pending step of a run that ended was never run; a skipped Track-title search or iTunes fallback says why in its own words.
  const mark = (step: Step) => step.state === 'pending' && !active ? 'notRun' : step.state === 'skipped' && (step.kind === 'trackTitle' || step.kind === 'itunes') ? 'notTaken' : step.state;
  // Why releases of other titles were found: an iTunes step that left results out says only some were compared, and a bridge
  // step with titles says they are what iTunes returned for the names searched.
  const note = (step: Step) => step.kind === 'itunes' && step.partial ? t('catalog_review.lookup_step_itunes_partial')
    : step.kind === 'bridge' && step.texts?.length ? t('catalog_review.lookup_step_bridge_note', { titles: titles(step) }) : null;
  // A stage's counts say what they count (releases read, iTunes searches, bridge checks, alias lookups); the bridge's also name the
  // titles it found.
  const counted = (step: Step, total: number) => STAGES.includes(step.kind) ? t(`catalog_review.lookup_step_counted_${step.kind}${step.kind === 'bridge' && step.texts?.length ? '_titles' : ''}`,
    { done: step.done ?? 0, total, titles: titles(step) }) : t('catalog_review.lookup_step_counted', { step: label(step), done: step.done ?? 0, total });
  const rows = <ol aria-label={t('catalog_review.lookup_steps')} className={styles.muted} style={{ listStyle: 'none', paddingLeft: 0 }}>{timeline.steps.map((step, index) =>
    <li key={`${step.kind}${index}`}>{t(`catalog_review.lookup_step_${mark(step)}`, { step: step.total ? counted(step, step.total) : label(step) })}
      {note(step) && <span style={{ display: 'block', paddingInlineStart: '1.2em' }}>{note(step)}</span>}</li>)}</ol>;
  const log = (body: ReactNode) => <div id={`${id}-log`} hidden={!open}>{body}</div>;
  if (active) {
    const wait = gateWaitSeconds(lookup, now, seen.current!.since);
    return <>{button}{below(log(<>{wait !== null && <p className={styles.muted}>{t('catalog_review.lookup_gate_wait', { source: lookup.progress?.phase === 'itunes' ? 'iTunes' : 'MusicBrainz', seconds: wait })}</p>}{rows}</>))}</>;
  }
  // A run that completed after MusicBrainz's retries ran out (its issue says so) may not have sent the searches it lists.
  const searched = lookup.state === 'complete' && lookup.issue === null ? searchedTexts(timeline) : [];
  return <>{button}{below(<>{link}
    {searched.length > 0 && <p>{t('catalog_review.lookup_searched', { searches: searched.map((entry, index) => index
      ? t(entry.artist ? 'catalog_review.lookup_searched_then' : 'catalog_review.lookup_searched_then_alone', { item: quote(entry) }) : quote(entry)).join('') })}</p>}
    {log(<><p className={styles.details}>{t('catalog_review.lookup_log', lookupRecord(lookup)!)}</p>{rows}</>)}</>)}</>;
}
