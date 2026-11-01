import { useQuery } from '@tanstack/react-query';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import { catalogReviewSummaryQuery } from './catalogReviewSummaryQuery';
import { reviewLookupBrief } from './reviewLookupBrief';
import styles from './adminStyles';

/**
 * The review's lookup brief from the summary's cached read (never polled from here; the review page's own brief,
 * reviewLookupBrief.ts), as the Luna AI controls read it. A free retry is promised only while the source is current. Used by the
 * Luna AI chunk (CatalogReviewLuna.tsx).
 */
export function useReviewBrief(item: CatalogReview) {
  const access = useAdminAccess(), captured = item.draft.album.expectedTracklist !== undefined;
  const read = useQuery({ ...catalogReviewSummaryQuery(access, item, true), refetchInterval: false, enabled: captured });
  const lookup = read.data?.lookup ?? null, submitted = lookup?.input.submitted;
  const brief = reviewLookupBrief(lookup, { available: (read.data?.summary.lookupAvailable ?? false) && item.sourceStatus === 'current', members: item.draft.tracks.length,
    searched: submitted?.kind === 'album' ? submitted.text : item.draft.album.title, artists: item.draft.album.artists.filter(entry => entry.role === 'primary').map(entry => entry.name) });
  return { captured, read, lookup, brief };
}

/**
 * Luna AI's status as one muted line, labelled Luna AI (paid, optional): beside its controls, or in the applied view
 * (CatalogReviewApplied.tsx). A failed run while the lookup path leads (`quiet`, only then) says calmly that it can be ignored.
 */
export function LunaStatus({ item, quiet = false }: { item: CatalogReview; quiet?: boolean }) {
  const t = useAdminText(), pending = item.suggestions.filter(value => value.decision === 'pending').length;
  if (quiet) return <p className={styles.muted}>{t('catalog_review.luna_failed_quiet')}</p>;
  const luna = item.state === 'applied' ? 'workbench.review_closed' : ['queued', 'running'].includes(item.analysis.state) ? 'workbench.review_analyzing'
    : item.analysis.state === 'needsAttention' ? 'workbench.review_needs_attention' : pending ? 'workbench.review_pending'
      : item.analysis.state === 'complete' ? 'workbench.review_handled' : item.analysis.state === 'cancelled' ? 'state.cancelled' : 'workbench.review_not_started';
  return <dl className={styles.muted} style={{ display: 'flex', flexWrap: 'wrap', columnGap: '.5rem' }}><dt>{t('workbench.review_stage')}</dt>
    <dd style={{ margin: 0 }}>{t(luna, luna === 'workbench.review_pending' ? { count: pending } : undefined)}</dd></dl>;
}
