import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './SocialPage.module.css';

export interface ConfirmActionDialogProps {
  title: string;
  /** States what the action changes for both people, so the consequence is read before confirming. */
  description: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirms one social safety action that cannot simply be undone (removing a friend, blocking, removing a room
 * member, replacing an invitation link). Cancel receives initial focus, so Enter, Escape or a stray click never
 * performs the action; focus returns to the trigger when the dialog closes. Callers load it lazily.
 */
export const ConfirmActionDialog = ({ title, description, confirmLabel, confirmDisabled = false, onConfirm, onCancel }: ConfirmActionDialogProps) => {
  const { t } = useLocalization();
  const cancel = useRef<HTMLButtonElement>(null);
  return createPortal(<ModalDialog title={title} description={description} initialFocusRef={cancel} onClose={onCancel}>
    <div className={styles.actions}>
      <button type="button" className={styles.danger} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button>
      <button type="button" className={styles.secondary} ref={cancel} onClick={onCancel}>{t('common.action.cancel')}</button>
    </div>
  </ModalDialog>, document.body);
};
