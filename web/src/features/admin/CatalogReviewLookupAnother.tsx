import { lazy, Suspense, type ComponentProps, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import type { CatalogReview } from './catalogReviewApi';
import { catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';
import type { LookupBox as Box } from './LookupBox';
import { lookupActive, lookupNextStep } from './lookupNextStep';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

/** Stands in for the name box when its chunk cannot load (a deploy replaced it); the row of alternatives above stays usable. */
function BoxUnavailable() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
const LookupBox = lazy<ComponentType<ComponentProps<typeof Box>>>(() => import('./LookupBox').then(module => ({ default: module.LookupBox }), () => ({ default: BoxUnavailable })));

/**
 * The review's name box (design v3), its own chunk under the page's row of alternatives, opened by Look up another name or by
 * itself where the status line makes it the next step. It reads the lookup summary from the status line's cache (no poll of its
 * own) and prefills the name with the last submitted name, else the saved Album title, and its optional Artist field with the
 * primary Artists' byline, so a saved title or a changed byline refills it and a stale prefill is never sent as typed. That byline
 * is sent as none only while the draft's primary Artists are the names the server searches without one: those it captured
 * (`primaryArtists`), or, before the review is captured for lookup (no expected tracklist key), the ones the submission's capture
 * reads them from. A completed run that found nothing adds the hint to try the name without its subtitle; while a run is active,
 * Look up asks before it replaces it (LookupBox.tsx). Cancel closes the box (`onCancel`).
 */
export function CatalogReviewLookupAnother({ item, disabled, onSubmit, onCancel }: {
  item: CatalogReview; disabled: boolean; onSubmit: (kind: 'album' | 'song', text: string, artist: string | null) => void; onCancel: () => void;
}) {
  const access = useAdminAccess(), online = useOnline();
  const query = useQuery({ ...catalogReviewSummaryQuery(access, item, online), refetchInterval: false }), data = query.data;
  if (!data) return null;
  const lookup = data.lookup, { status } = lookupNextStep(lookup, { available: data.summary.lookupAvailable, uploadsWaiting: false });
  const primary = item.draft.album.artists.filter(entry => entry.role === 'primary'), byline = entriesByline(primary);
  const implicit = item.draft.album.expectedTracklist === undefined || JSON.stringify(primary.map(entry => entry.name)) === JSON.stringify(data.summary.primaryArtists);
  const box = `${lookup?.input.submitted ? String(lookup.run) : `${lookup?.run ?? 0}:${item.draft.album.title}`}:${byline}`;
  return <div className={styles.lookupDetails}><Suspense fallback={null}><LookupBox key={box} lookup={lookup} rootLabel="" defaultText={item.draft.album.title} mode="review"
    disabled={disabled || query.isPlaceholderData} defaultArtist={byline} defaultArtistImplicit={implicit} hint={['lookup.no_match', 'lookup.no_release'].includes(status)}
    active={lookupActive(lookup?.state)} onSubmit={onSubmit} onCancel={onCancel} /></Suspense></div>;
}
