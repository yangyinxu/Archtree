import { useEffect, useId, useRef, useState } from 'react';
import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import { LunaStatus, useReviewBrief } from './catalogReviewBrief';
import { lookupBriefLeads } from './lookupBrief';
import { lookupActive } from './lookupNextStep';
import styles from './adminStyles';

/** A project's Luna AI runs (the server's ADMIN_IMPORT_LIMITS.generations), as the review page's own Luna AI check reads it. */
const LUNA_RUNS = 2;
/** Luna AI calls per run of a review with `tracks` members: one for the Album and one per ten tracks, as the server chunks them. */
const callsPerRun = (tracks: number) => 1 + Math.ceil(tracks / 10);

/**
 * How many more Luna AI runs the project can start: its runs left, as far as its paid calls left still cover a whole run. It reads
 * the review detail's analysis, the same source as LunaStatus.
 */
export function lunaRunsLeft(item: CatalogReview): number {
  const calls = callsPerRun(item.draft.tracks.length), { generation, maxAttempts, attemptsUsed } = item.analysis;
  return Math.max(0, Math.min(LUNA_RUNS - generation, Math.floor((maxAttempts - attemptsUsed) / calls)));
}

/**
 * Luna AI's controls on an unapplied completion (its own lazy chunk; the review page asks for a reload in its place when it cannot
 * load): its status once Luna AI was used, Use Luna AI (paid), or Stop Luna AI while it runs, then why it cannot run. Luna AI follows
 * the metadata lookup summary as a paid, secondary action; its button is never primary. While the lookup path leads
 * (lookupBriefLeads), a failed run is one quiet line that says it can be ignored, and of its issues only an unknown outcome, which
 * keeps Luna AI from starting, is said, muted.
 *
 * Use Luna AI (paid) opens an inline, non-modal confirmation below it (owner rules: docs/business-rules.md, Administrator Album
 * Imports, Luna labels), focused on its safe choice. While the review's free metadata lookup is queued, running or retrying (the
 * summary's cached read, which the summary keeps polling), it warns that free results are pending and offers Wait for free results,
 * which only closes it, beside Start Luna AI anyway (paid); once the lookup ends its labels turn into Cancel and Start Luna AI
 * analysis (paid) in place, and nothing starts until one is pressed: Luna AI never starts by itself. A run that starts meanwhile
 * (also from another tab) or an applied review closes it for good. It gives the project's Luna AI
 * runs left (two less the runs used) and paid calls left, and when the project has exactly one Luna AI run left (lunaRunsLeft: its
 * runs left, as far as its paid calls left cover a whole run) it says this is the last. Starting calls `onAnalyze`, which sends the review's current
 * revision; it stays unavailable while `canAnalyze` is false or a change is `busy`.
 */
export function CatalogReviewLuna({ item, active, canAnalyze, busy, onAnalyze, onStop }: { item: CatalogReview; active: boolean; canAnalyze: boolean; busy: boolean;
  /** Starts Luna AI; called only from the confirmation's start button. */
  onAnalyze: () => void; onStop: () => void }) {
  const t = useAdminText(), uid = useId(), { lookup, brief } = useReviewBrief(item), issue = item.analysis.issue;
  const quiet = item.analysis.state === 'needsAttention' && lookupBriefLeads(brief);
  const opener = useRef<HTMLButtonElement>(null), safe = useRef<HTMLButtonElement>(null);
  // Whether the focus was last inside the confirmation (a removed element sends no blur, so only a move elsewhere clears it).
  const inside = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const ended = active || item.state === 'applied', showing = confirming && !ended, waiting = lookupActive(lookup?.state);
  // A run that started (here or elsewhere) or an applied review closes the confirmation for good, so it never comes back when that
  // run ends; a focus it held, lost with it, goes to its opener (Stop Luna AI while the run shows).
  useEffect(() => {
    if (!ended || !confirming) return;
    setConfirming(false);
    if (inside.current && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus();
    inside.current = false;
  }, [ended]);
  useEffect(() => { if (showing) safe.current?.focus(); }, [showing]);
  // Closing returns the focus to the button that opened it, which becomes Stop Luna AI once a started run shows.
  const close = () => { setConfirming(false); inside.current = false; opener.current?.focus(); };
  return <>
    {(item.analysis.generation > 0 || active) && <LunaStatus item={item} quiet={quiet} />}
    {/* One button element for both actions, so the focus stays on it when a started run turns it into Stop. */}
    <div className={styles.actions}>{active
      ? <button ref={opener} className={styles.button} type="button" disabled={busy} onClick={onStop}>{t('analysis.stop')}</button>
      : <button ref={opener} className={styles.button} type="button" disabled={!canAnalyze} aria-expanded={showing} aria-controls={showing ? `${uid}-confirm` : undefined}
        onClick={() => setConfirming(true)}>{t(item.analysis.generation ? 'catalog_review.analysis_again' : 'catalog_review.analysis_confirm')}</button>}</div>
    {showing && <section id={`${uid}-confirm`} role="dialog" aria-modal="false" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-copy`} className={styles.card}
      onFocus={() => { inside.current = true; }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) inside.current = false; }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
      <h3 id={`${uid}-title`}>{t('catalog_review.analysis_confirm_title')}</h3>
      {waiting && <div role="note" className={styles.notice}><strong>{t('catalog_review.luna_concurrent_title')}</strong><p>{t('catalog_review.luna_concurrent_copy')}</p></div>}
      <p id={`${uid}-copy`}>{t('catalog_review.analysis_copy')}</p>
      <p>{t('catalog_review.luna_budget', { runs: Math.max(0, LUNA_RUNS - item.analysis.generation), attempts: Math.max(0, item.analysis.maxAttempts - item.analysis.attemptsUsed) })}</p>
      {lunaRunsLeft(item) === 1 && <p>{t('catalog_review.luna_last_run')}</p>}
      <div className={styles.dialogActions}>
        <button ref={safe} className={styles.button} type="button" onClick={close}>{t(waiting ? 'catalog_review.luna_wait' : 'common.cancel')}</button>
        <button className={`${styles.button} ${styles.primary}`} type="button" disabled={!canAnalyze || busy} onClick={() => { close(); onAnalyze(); }}>
          {t(waiting ? 'catalog_review.luna_start_anyway' : 'catalog_review.luna_start')}</button></div>
    </section>}
    {active && <p role="status" className={styles.muted}>{t('catalog_review.analysis_running')}</p>}
    {!item.capabilities.analysis && <p>{t('analysis.unavailable')}</p>}
    {item.analysis.generation >= LUNA_RUNS && <p>{t('catalog_review.analysis_limit')}</p>}
    {issue && (!quiet || issue === 'providerOutcomeUnknown') && <p role="status" className={quiet ? styles.muted : undefined}>{t(`issue.${issue}`)}</p>}
  </>;
}
