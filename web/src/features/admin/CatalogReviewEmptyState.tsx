import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import styles from './adminStyles';

/** An empty suggestion list has different next steps depending on analysis and saved draft changes. */
export function CatalogReviewEmptyState({ item, changeCount, onNavigate }: {
  item: CatalogReview; changeCount: number; onNavigate: (stage: 'draft' | 'apply') => void;
}) {
  const t = useAdminText();
  const active = ['queued', 'running'].includes(item.analysis.state);
  const key = item.state === 'applied' ? 'catalog_review.applied_copy' : active ? 'catalog_review.analysis_running'
    : item.analysis.state === 'needsAttention' ? 'catalog_review.empty_attention'
      : item.suggestions.some(value => value.field === 'artists' && value.decision === 'pending') ? 'catalog_review.empty_artist'
        : changeCount ? 'catalog_review.empty_ready' : item.analysis.state === 'cancelled' ? 'catalog_review.empty_cancelled'
          : item.analysis.state !== 'complete' ? 'catalog_review.empty_idle'
            : item.suggestions.length ? 'catalog_review.empty_handled' : 'catalog_review.empty_no_suggestions';
  return <div><p role="status">{t(key)}</p>{item.state !== 'applied' && !active && <button className={styles.button} type="button"
    onClick={() => onNavigate(changeCount ? 'apply' : 'draft')}>{t(changeCount ? 'catalog_review.view_changes' : 'catalog_review.draft_tab', changeCount ? { count: changeCount } : undefined)}</button>}</div>;
}
