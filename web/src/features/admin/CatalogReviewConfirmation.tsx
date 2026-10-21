import { useRef } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminText } from './AdminAccess';
import { CatalogReviewChangeSummary } from './CatalogReviewApply';
import { reviewFieldKey, type CatalogReview, type ReviewChange, type ReviewField } from './catalogReviewApi';
import styles from './adminStyles';

/** Captures the original project and selected values until the parent validates the final command. */
export type Confirmation = { kind: 'analyze'; item: CatalogReview }
  | { kind: 'apply'; item: CatalogReview; fields: ReviewField[]; changes: ReviewChange[] };

/** Displays frozen confirmation data; authorization and mutation dispatch remain in the parent. */
export function CatalogReviewConfirmation({ confirmation, disabled, onClose, onConfirm }: {
  confirmation: Confirmation; disabled: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const t = useAdminText();
  const cancel = useRef<HTMLButtonElement>(null);
  return <ModalDialog title={t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_confirm_title' : 'catalog_review.apply_confirm')}
    description={t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_copy' : 'catalog_review.apply_copy')}
    headerContent={<div className={styles.target}><strong>{confirmation.item.source.album.title || t('common.untitled')}</strong>
      {confirmation.kind === 'apply' && <p>{t('catalog_review.selected', { count: confirmation.fields.length })}</p>}</div>}
    initialFocusRef={cancel} onClose={onClose}>
    {confirmation.kind === 'apply' && confirmation.changes.map(change => <CatalogReviewChangeSummary key={reviewFieldKey(change)} change={change} />)}
    {/* Apply starts at the dialog, so focusing its footer cannot skip a long change summary. */}
    <div className={styles.dialogActions}><button className={styles.button} type="button" ref={confirmation.kind === 'analyze' ? cancel : undefined} onClick={onClose}>{t('common.cancel')}</button>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled} onClick={onConfirm}>
        {t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_confirm' : 'catalog_review.apply_action', confirmation.kind === 'apply' ? { count: confirmation.fields.length } : undefined)}
      </button></div>
  </ModalDialog>;
}
