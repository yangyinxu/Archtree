import { useRef } from 'react';
import { Link } from 'react-router';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminText } from './AdminAccess';
import type { ReviewLookupView } from './importLookupApi';
import { gateWaitSeconds, lookupRecord, searchedTexts, titleSearch } from './lookupProgressModel';
import styles from './adminStyles';

type Timeline = NonNullable<ReviewLookupView['timeline']>;
type Step = Timeline['steps'][number];
type Text = NonNullable<Step['texts']>[number];

/**
 * The steps of an existing-Album review's lookup run (its own lazy chunk, review only; when it cannot load, the summary renders
 * nothing in its place, or asks for a reload where it would carry the Album link). While a run is queued, running or retrying: its
 * steps in order with what each searched, their states and counts, and while a running run has shown no new step for more than
 * five seconds of this page's clock (`now`, the summary's last read), that it waits for MusicBrainz (iTunes in the iTunes phase).
 * After a run that completed with no issue: the names it searched, then the steps folded under its record (time taken, searches
 * and releases found); any other ended run, also one that completed after MusicBrainz's retries ran out, folds its steps the same
 * way without the names. A search the run may not have sent reads as such and is never named or counted. With `albumHref` (a run
 * that ended because the Album changed) the link to open the Album and start a new completion comes first, also without a
 * timeline. The list is no live region, as every poll changes it.
 */
export function LookupProgress({ lookup, now, albumHref }: { lookup: ReviewLookupView; now: number; albumHref: string | null }) {
  const t = useAdminText(), { locale } = useLocalization(), timeline = lookup.timeline;
  // When this page first saw the run's current last step, on its own clock.
  const seen = useRef<{ at: string; since: number } | null>(null);
  if (timeline && seen.current?.at !== timeline.updatedAt) seen.current = { at: timeline.updatedAt, since: now };
  const link = albumHref && <div className={styles.actions}><Link className={`${styles.link} ${styles.primary}`} to={albumHref}>{t('catalog_review.lookup_superseded_open')}</Link></div>;
  if (!timeline) return link || null;
  const active = lookup.state === 'queued' || lookup.state === 'running' || lookup.state === 'retrying', search = timeline.trackTitleSearch;
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
  const rows = <ol aria-label={t('catalog_review.lookup_steps')} className={styles.muted} style={{ listStyle: 'none', paddingLeft: 0 }}>{timeline.steps.map((step, index) =>
    <li key={`${step.kind}${index}`}>{t(`catalog_review.lookup_step_${mark(step)}`, { step: step.total ? t('catalog_review.lookup_step_counted', { step: label(step), done: step.done ?? 0, total: step.total })
      : label(step) })}</li>)}</ol>;
  if (active) {
    const wait = gateWaitSeconds(lookup, now, seen.current!.since);
    return <>{wait !== null && <p className={styles.muted}>{t('catalog_review.lookup_gate_wait', { source: lookup.progress?.phase === 'itunes' ? 'iTunes' : 'MusicBrainz', seconds: wait })}</p>}{rows}</>;
  }
  // A run that completed after MusicBrainz's retries ran out (its issue says so) may not have sent the searches it lists.
  const searched = lookup.state === 'complete' && lookup.issue === null ? searchedTexts(timeline) : [];
  return <>{link}
    {searched.length > 0 && <p>{t('catalog_review.lookup_searched', { searches: searched.map((entry, index) => index
      ? t(entry.artist ? 'catalog_review.lookup_searched_then' : 'catalog_review.lookup_searched_then_alone', { item: quote(entry) }) : quote(entry)).join('') })}</p>}
    <details className={styles.details}><summary>{t('catalog_review.lookup_log', lookupRecord(lookup)!)}</summary>{rows}</details></>;
}
