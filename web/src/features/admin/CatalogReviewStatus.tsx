import { lazy, useEffect, Suspense, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import { catalogReviewKey, catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';
import type { LookupProgress as Progress } from './LookupProgress';
import { lookupNextStep } from './lookupNextStep';
import { titleNumbers, type Message } from './reviewLookupStatus';
import { progressPhaseKey, reviewStatusLine, type StatusLine } from './reviewStatusLine';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

/** What the page's row of alternatives needs from the status: the run, whether the name box is its next step, and whether lookup is available. */
export type LookupNext = { run: number; box: boolean; available: boolean };

/**
 * The lookup steps are supplementary: a chunk that cannot load leaves them out (keeping the status line) and asks for nothing,
 * unless it carried the only next step, the Album link of a run that ended because the Album changed; then it asks for a reload.
 */
const LookupProgress = lazy<ComponentType<ComponentProps<typeof Progress>>>(() => import('./LookupProgress').then(module => ({ default: module.LookupProgress }),
  () => ({ default: ({ albumHref }: ComponentProps<typeof Progress>) => albumHref && <div><Reload /></div> })));
function Reload() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }

/** The line's icon, drawn inline (as lucide's check, clock, circle-alert and search) so the chunk carries no icon library. */
const ICONS: Record<StatusLine['tone'], ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6h4.5" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>
};
const StatusIcon = ({ tone }: { tone: StatusLine['tone'] }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICONS[tone]}</svg>;

/**
 * The review page's one status line under its header (design v3; owner rules: docs/business-rules.md, Administrator Metadata
 * Lookup and Luna AI), its own chunk: an icon, a short headline (the polite status, mounted in one place whether or not a run
 * exists or the steps' chunk has loaded) and one sentence naming the next step (reviewStatusLine.ts), with the run's Details
 * toggle on the right (LookupProgress.tsx) whose log holds an active run's time and that it keeps running after the page is left,
 * the names searched, the run's record and its steps. While Luna AI runs, alone or beside the lookup, the headline says so; Luna AI
 * is never a next step. It is the page's poller of the lookup summary read (the lookup details below share its cache), reads the
 * review detail again when that read shows a newer revision or value revision (lookup applications change only the latter), and
 * tells the page (`onNext`) the run, whether the name box is its next step and whether lookup is available, so the row of
 * alternatives offers Look up another name and opens it by itself. It is no landmark: the Metadata lookup region is the details'.
 */
export function CatalogReviewStatus({ item, onNext }: { item: CatalogReview; onNext: (next: LookupNext) => void }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), client = useQueryClient(), { locale } = useLocalization();
  const query = useQuery(catalogReviewSummaryQuery(access, item, online)), data = query.data, lookup = data?.lookup ?? null, summary = data?.summary;
  useEffect(() => {
    if (data && !query.isPlaceholderData && (data.revision > item.revision || data.valueRevision > item.valueRevision))
      void client.invalidateQueries({ queryKey: catalogReviewKey(access, item.id), exact: true });
  }, [data]);
  // The Album name the run searched (a song name never is: then the saved title) compares the titles; the captured titles over the
  // saved numbers give the numbers the review page proposes (catalogReviewProposal.ts reads them the same way).
  const submitted = lookup?.input.submitted, searched = submitted?.kind === 'album' ? submitted.text : item.draft.album.title;
  const artists = item.draft.album.artists.filter(entry => entry.role === 'primary').map(entry => entry.name);
  const line = summary ? reviewStatusLine(lookup, { status: lookupNextStep(lookup, { available: summary.lookupAvailable, uploadsWaiting: false }).status, available: summary.lookupAvailable,
    luna: ['queued', 'running'].includes(item.analysis.state), members: item.draft.tracks.length, searched, artists, now: query.dataUpdatedAt || Date.now(),
    numbers: titleNumbers(item.source.tracks.map(track => ({ ...item.draft.tracks.find(value => value.slotId === track.slotId)!, title: track.title })),
      new Set(item.source.tracks.filter(track => track.discNumber !== undefined).map(track => track.slotId))),
    time: at => new Date(at).toLocaleTimeString(locale, { timeStyle: 'medium' }) }) : null;
  const run = lookup?.run ?? 0, box = Boolean(line?.box), available = Boolean(summary?.lookupAvailable);
  useEffect(() => { if (line) onNext({ run, box, available }); }, [Boolean(line), run, box, available]);
  const say = (message: Message) => t(message.key, message.values?.phase ? { ...message.values, phase: t(progressPhaseKey(String(message.values.phase))) } : message.values);
  // A heading for assistive technology only (design v3 shows none), last so the line stays the layout's first child: at the
  // page's h2 level, so the h3 sections of the update range and the lookup details keep the heading order with or without proposals.
  const heading = <h2 className="visually-hidden">{t('catalog_review.lookup_title')}</h2>;
  if (!line) return <div id="catalog-review-status" className={styles.statusLine}>{query.isError
    ? <div><p role="alert">{t('common.error')}</p><button className={styles.button} type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retry')}</button></div>
    : <div><strong role="status">{t('common.loading')}</strong></div>}{heading}</div>;
  return <div id="catalog-review-status" className={styles.statusLine}>
    <div><strong role="status"><StatusIcon tone={line.tone} />{say(line.head)}</strong>
      {line.line && <p className={styles.muted}>{say(line.line)}</p>}</div>
    {lookup && <Suspense fallback={null}><LookupProgress lookup={lookup} now={query.dataUpdatedAt || Date.now()} notes={line.notes.map(say)}
      albumHref={lookup.state === 'superseded' && item.sourceStatus === 'changed' ? `/admin/catalog/album/${item.source.album.id}` : null} /></Suspense>}
    {heading}
  </div>;
}
