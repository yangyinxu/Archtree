import { useRef, type RefObject } from 'react';
import { Link } from 'react-router';

import { ModalDialog } from '../../components/ModalDialog';
import styles from './Playlists.module.css';

/** Explains the private-account requirement without forcing login navigation. */
export const SignedOutPlaylistDialog = ({
  onClose,
  returnFocusRef,
  accountUnavailable = false,
  title = 'Log in to create a Playlist',
  description = 'Playlists are private to your Finitude account. You can keep browsing without signing in.'
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  accountUnavailable?: boolean;
  title?: string;
  description?: string;
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog
      description={accountUnavailable
        ? 'Finitude could not safely confirm your account. Try again after the account status returns.'
        : description}
      initialFocusRef={closeRef}
      kicker="Sign-in required"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={accountUnavailable ? 'Account status unavailable' : title}
    >
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} onClick={onClose} ref={closeRef} type="button">Close</button>
        {!accountUnavailable && <Link className={styles.primaryButton} onClick={onClose} state={{ from: '/playlists' }} to="/login">Log in</Link>}
      </div>
    </ModalDialog>
  );
};
