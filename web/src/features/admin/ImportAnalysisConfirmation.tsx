import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess, useAdminText } from './AdminAccess';
import type { ImportDetail } from './adminApi';
import { importSummaryQuery } from './importSummaryQuery';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

/**
 * The one confirmation of a paid Luna analysis, opened from the Draft section's Analyze and from the summary's Luna next step. It
 * shows what is left of the project and daily budget (the summary read) and starts nothing until confirmed; Analyze stays
 * unavailable while the budget is unknown or cannot cover one more run (one call for the Album and one per ten files).
 */
export function ImportAnalysisConfirmation({ item, disabled, onConfirm, onClose }: { item: ImportDetail; disabled: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), cancel = useRef<HTMLButtonElement>(null);
  const read = useQuery(importSummaryQuery(access, item, online)), budget = read.data?.summary.analysis, calls = 1 + Math.ceil(item.manifest.files.length / 10);
  return <ModalDialog title={t('analysis.confirm_title')} description={t('analysis.confirm')} initialFocusRef={cancel} onClose={onClose}>
    {budget ? <ul><li>{t('analysis.budget_project', { runs: budget.runs, attempts: budget.attempts })}</li><li>{t('analysis.budget_daily', { daily: budget.daily })}</li></ul>
      : <p role="status">{t(read.isError ? 'common.error' : 'common.loading')}</p>}
    <div className={styles.dialogActions}><button ref={cancel} className={styles.button} type="button" onClick={onClose}>{t('common.cancel')}</button>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled || !budget || budget.runs < 1 || budget.attempts < calls || budget.daily < calls} onClick={onConfirm}>{t('analysis.confirm_action')}</button></div>
  </ModalDialog>;
}
