import { useRef, type RefObject } from 'react';
import { Link } from 'react-router';

import { ModalDialog } from '../../components/ModalDialog';
import styles from './Playlists.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Explains the private-account requirement without forcing login navigation. */
export const SignedOutPlaylistDialog = ({
  onClose,
  returnFocusRef,
  accountUnavailable = false,
  title,
  description
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  accountUnavailable?: boolean;
  title?: string;
  description?: string;
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { t } = useLocalization();
  return (
    <ModalDialog
      description={accountUnavailable
        ? t('playlist.signed_out.account_error_copy')
        : description ?? t('playlist.signed_out.description')}
      initialFocusRef={closeRef}
      kicker={t('playlist.signed_out.kicker')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={accountUnavailable
        ? t('playlist.signed_out.account_error_title')
        : title ?? t('playlist.signed_out.title')}
    >
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} onClick={onClose} ref={closeRef} type="button">{t('common.action.close')}</button>
        {!accountUnavailable && <Link className={styles.primaryButton} onClick={onClose} state={{ from: '/playlists' }} to="/login">{t('common.action.log_in')}</Link>}
      </div>
    </ModalDialog>
  );
};
