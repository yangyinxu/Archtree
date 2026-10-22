import { Fragment, useRef } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import type { ReviewApplySelection } from './catalogReviewApplyModel';
import { ApplyAlbumNote, ApplyIdentityLines, ApplyItemSummary } from './CatalogReviewApplyItems';
import styles from './adminStyles';

/** Captures the original project and the frozen selection (its items, identities and apply body) until the parent validates the final command. */
export type Confirmation = { kind: 'analyze'; item: CatalogReview } | { kind: 'apply'; item: CatalogReview; selection: ReviewApplySelection };

/** Displays frozen confirmation data; authorization and mutation dispatch remain in the parent. */
export function CatalogReviewConfirmation({ confirmation, disabled, onClose, onConfirm }: {
  confirmation: Confirmation; disabled: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const t = useAdminText();
  const cancel = useRef<HTMLButtonElement>(null);
  const selection = confirmation.kind === 'apply' ? confirmation.selection : null, count = selection ? selection.fields.length + selection.memberCredits.length : 0;
  return <ModalDialog title={t(selection ? 'catalog_review.apply_confirm' : 'catalog_review.analysis_confirm_title')}
    description={t(selection ? 'catalog_review.apply_confirm_copy' : 'catalog_review.analysis_copy')}
    headerContent={<div className={styles.target}><strong>{confirmation.item.source.album.title || t('common.untitled')}</strong>
      {selection && <p>{t('catalog_review.selected', { count })}</p>}</div>}
    initialFocusRef={cancel} onClose={onClose}>
    {selection && <>
      {selection.items.map(item => <Fragment key={item.key}><ApplyItemSummary item={item} />
        {item.key === 'album::artists' && selection.albumNote && <ApplyAlbumNote item={confirmation.item} namingReplaced={selection.albumNote.namingReplaced} />}</Fragment>)}
      {selection.identities.length > 0 && <ApplyIdentityLines lines={selection.identities} />}
    </>}
    {/* Apply starts at the dialog, so focusing its footer cannot skip a long change summary. */}
    <div className={styles.dialogActions}><button className={styles.button} type="button" ref={selection ? undefined : cancel} onClick={onClose}>{t('common.cancel')}</button>
      <button className={`${styles.button} ${styles.primary}`} type="button" disabled={disabled} onClick={onConfirm}>
        {t(selection ? 'catalog_review.apply_action' : 'catalog_review.analysis_confirm', selection ? { count } : undefined)}
      </button></div>
  </ModalDialog>;
}
