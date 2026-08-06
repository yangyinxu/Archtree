import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

import {
  clearAccountListeningHistory,
  deleteListenerAccount,
  isAvatarDeletionRequired,
  signOutAccountEverywhere
} from '../../api/accountLifecycle';
import {
  captureAccountOperation,
  isAccountOperationCurrent,
  type AccountOperationGuard
} from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import { browserSessionQueryKey } from '../../api/session';
import { clearSearchHistory } from '../search/searchHistory';
import styles from './AccountLifecyclePanel.module.css';

type LifecycleAction = 'clearHistory' | 'signOutEverywhere' | 'deleteAccount';

interface AccountLifecyclePanelProps {
  /** Keys all client cleanup to the authoritative account currently on screen. */
  viewerId: string;
}

interface ConfirmationCopy {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  fallbackError: string;
}

const confirmationCopy: Record<LifecycleAction, ConfirmationCopy> = {
  clearHistory: {
    title: 'Clear listening history?',
    description: 'This removes your Recently Played activity. Your saved albums and soundtracks stay in Library.',
    confirmLabel: 'Clear history',
    pendingLabel: 'Clearing…',
    fallbackError: 'Finitude could not clear your listening history. Please try again.'
  },
  signOutEverywhere: {
    title: 'Sign out everywhere?',
    description: 'Every Finitude session, including this browser, will be signed out. Public audio that is already playing will keep playing.',
    confirmLabel: 'Sign out everywhere',
    pendingLabel: 'Signing out…',
    fallbackError: 'Finitude could not sign out every device. Please try again.'
  },
  deleteAccount: {
    title: 'Permanently delete your account?',
    description: 'This permanently removes your Library, listening activity, sign-in methods, and sessions. This action cannot be undone.',
    confirmLabel: 'Delete account permanently',
    pendingLabel: 'Deleting…',
    fallbackError: 'Finitude could not delete your account. Please try again.'
  }
};

const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
  ));
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeIsFocusable = focusable.includes(document.activeElement as HTMLElement);

  if (!activeIsFocusable) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

interface ConfirmationDialogProps {
  action: LifecycleAction;
  error: unknown;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Keeps destructive account actions inside one labelled, keyboard-contained modal. */
const ConfirmationDialog = ({
  action,
  error,
  pending,
  onCancel,
  onConfirm
}: ConfirmationDialogProps) => {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copy = confirmationCopy[action];
  const avatarBlocked = action === 'deleteAccount' && isAvatarDeletionRequired(error);
  const errorMessage = avatarBlocked
    ? 'Remove your profile photo first, then return here to delete your account.'
    : error instanceof ApiError
      ? error.message
      : error
        ? copy.fallbackError
        : null;

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  return (
    <div className={styles.backdrop}>
      <section
        aria-describedby="account-lifecycle-confirmation-description"
        aria-labelledby="account-lifecycle-confirmation-title"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            onCancel();
            return;
          }
          trapDialogFocus(event);
        }}
        role="dialog"
        tabIndex={-1}
      >
        <p className={styles.dialogEyebrow}>Please confirm</p>
        <h3 className={styles.dialogTitle} id="account-lifecycle-confirmation-title">{copy.title}</h3>
        <p className={styles.dialogCopy} id="account-lifecycle-confirmation-description">{copy.description}</p>
        {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
        <div className={styles.dialogActions}>
          <button
            className={styles.cancelButton}
            disabled={pending}
            onClick={onCancel}
            ref={cancelButton}
            type="button"
          >
            Cancel
          </button>
          <button
            aria-label={action === 'signOutEverywhere' ? 'Confirm sign out everywhere' : undefined}
            className={styles.confirmButton}
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? copy.pendingLabel : copy.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
};

/** Presents recoverable account lifecycle controls without owning or stopping playback. */
export const AccountLifecyclePanel = ({ viewerId }: AccountLifecyclePanelProps) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const activeViewer = useRef(viewerId);
  activeViewer.current = viewerId;
  const localOwner = useRef(viewerId);
  const ownsLocalState = localOwner.current === viewerId;
  const visibleConfirmation = ownsLocalState ? confirmation : null;
  const visibleNotice = ownsLocalState ? notice : null;

  const closeConfirmation = () => {
    setConfirmation(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => target?.focus());
  };

  const finishSessionExit = (
    actedViewerId: string,
    guard: AccountOperationGuard,
    message: string
  ) => {
    if (actedViewerId !== activeViewer.current || !isAccountOperationCurrent(guard)) return;
    clearSearchHistory(actedViewerId);
    queryClient.clear();
    queryClient.setQueryData(browserSessionQueryKey, null);
    setConfirmation(null);
    setNotice(message);
    navigate('/', { replace: true });
  };

  const clearHistory = useMutation({
    mutationFn: clearAccountListeningHistory,
    onMutate: (actedViewerId) => captureAccountOperation(actedViewerId),
    onSuccess: (_result, actedViewerId, guard) => {
      if (actedViewerId !== activeViewer.current || !isAccountOperationCurrent(guard)) return;
      closeConfirmation();
      setNotice('Listening history cleared. Your saved Library was not changed.');
      void queryClient.invalidateQueries({ queryKey: ['listener', 'home', actedViewerId] });
      void queryClient.invalidateQueries({ queryKey: ['listener', 'library', actedViewerId] });
    }
  });
  const signOutEverywhere = useMutation({
    mutationFn: signOutAccountEverywhere,
    onSuccess: (guard, actedViewerId) => finishSessionExit(
      actedViewerId,
      guard,
      'You have been signed out everywhere.'
    )
  });
  const deleteAccount = useMutation({
    mutationFn: deleteListenerAccount,
    onSuccess: (guard, actedViewerId) => finishSessionExit(
      actedViewerId,
      guard,
      'Your account has been deleted.'
    )
  });

  useEffect(() => {
    localOwner.current = viewerId;
    setConfirmation(null);
    setNotice(null);
    returnFocus.current = null;
    clearHistory.reset();
    signOutEverywhere.reset();
    deleteAccount.reset();
  }, [viewerId]);

  const openConfirmation = (
    action: LifecycleAction,
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    clearHistory.reset();
    signOutEverywhere.reset();
    deleteAccount.reset();
    setNotice(null);
    returnFocus.current = event.currentTarget;
    setConfirmation(action);
  };

  const currentMutation = visibleConfirmation === 'clearHistory'
    ? clearHistory
    : visibleConfirmation === 'signOutEverywhere'
      ? signOutEverywhere
      : deleteAccount;

  const confirm = () => {
    if (visibleConfirmation === 'clearHistory') clearHistory.mutate(viewerId);
    if (visibleConfirmation === 'signOutEverywhere') signOutEverywhere.mutate(viewerId);
    if (visibleConfirmation === 'deleteAccount') deleteAccount.mutate(viewerId);
  };

  return (
    <section aria-labelledby="account-lifecycle-heading" className={styles.panel}>
      <div className={styles.headingBlock}>
        <p className={styles.eyebrow}>Privacy and account</p>
        <h2 className={styles.heading} id="account-lifecycle-heading">Your Finitude data</h2>
      </div>

      {visibleNotice && <p className={styles.status} role="status">{visibleNotice}</p>}

      <div className={styles.actionList}>
        <div className={styles.actionRow}>
          <div>
            <h3>Listening history</h3>
            <p>Remove Recently Played activity without removing anything from your saved Library.</p>
          </div>
          <button className={styles.secondaryButton} onClick={(event) => openConfirmation('clearHistory', event)} type="button">
            Clear listening history
          </button>
        </div>

        <div className={styles.actionRow}>
          <div>
            <h3>All signed-in devices</h3>
            <p>End every active session and clear this browser's private account data.</p>
          </div>
          <button className={styles.secondaryButton} onClick={(event) => openConfirmation('signOutEverywhere', event)} type="button">
            Sign out everywhere
          </button>
        </div>

        <div className={`${styles.actionRow} ${styles.dangerRow}`}>
          <div>
            <h3>Delete account</h3>
            <p>Permanently remove your listener account and its saved and authentication data.</p>
          </div>
          <button className={styles.dangerButton} onClick={(event) => openConfirmation('deleteAccount', event)} type="button">
            Delete account
          </button>
        </div>
      </div>

      {visibleConfirmation && (
        <ConfirmationDialog
          action={visibleConfirmation}
          error={currentMutation.error}
          onCancel={closeConfirmation}
          onConfirm={confirm}
          pending={currentMutation.isPending}
        />
      )}
    </section>
  );
};
