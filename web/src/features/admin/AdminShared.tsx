import type { ImportDetail, WorkbenchItem } from './adminApi';
import { useAdminText } from './AdminAccess';
import type { useAdminMutation } from './useAdminMutation';
import styles from './adminStyles';

export { useOnline } from './useAdminOnline';
export function ImportStages({ item }: { item: WorkbenchItem | ImportDetail }) {
  const t = useAdminText();
  const pending = 'suggestions' in item ? item.suggestions.filter(suggestion => suggestion.decision === 'pending').length : item.pendingSuggestions;
  const analysis = item.analysis.state === 'idle' ? 'notStarted' : item.analysis.state === 'needsAttention' ? 'failed' : item.analysis.state;
  return <dl className={styles.statusRow}>
    <div><dt>{t('stage.upload')}</dt><dd>{item.upload.ready}/{item.upload.total}{!item.upload.available && ` · ${t('state.notAvailable')}`}</dd></div>
    <div><dt>{t('stage.analysis')}</dt><dd>{t(`state.${analysis}`)}{item.analysis.totalChunks > 0 && ` · ${item.analysis.completedChunks}/${item.analysis.totalChunks}`}</dd></div>
    <div><dt>{t('stage.review')}</dt><dd>{pending ? `${t('state.needsReview')} · ${pending}` : t(item.analysis.state === 'complete' ? 'state.approved' : 'state.notStarted')}</dd></div>
    <div><dt>{t('stage.publication')}</dt><dd>{t(`state.${item.publication === 'needsAttention' ? 'failed' : item.publication}`)}</dd></div>
  </dl>;
}
export function MutationStatus({ mutation }: { mutation: ReturnType<typeof useAdminMutation> }) {
  const t = useAdminText();
  if (mutation.running) return <p role="status">{t('common.saving')}</p>;
  if (!mutation.error) return null;
  return <div role="alert" className={styles.error}><p>{t(`common.${mutation.error}`)}</p>
    {mutation.intent && <button type="button" className={styles.button} onClick={mutation.operation.retry}>{t('common.retry_operation')}</button>}
  </div>;
}
