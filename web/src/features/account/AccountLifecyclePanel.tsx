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
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { clearSearchHistory } from '../search/searchHistory';
import styles from './AccountLifecyclePanel.module.css';

type LifecycleAction = 'clearHistory' | 'signOutEverywhere' | 'deleteAccount';

interface AccountLifecyclePanelProps {
  /** Keys all client cleanup to the authoritative account currently on screen. */
  viewerId: string;
}

interface ConfirmationCopy {
  title: MessageKey;
  description: MessageKey;
  confirmLabel: MessageKey;
  pendingLabel: MessageKey;
  fallbackError: MessageKey;
}

const confirmationCopy: Record<LifecycleAction, ConfirmationCopy> = {
  clearHistory: {
    title: 'account.lifecycle.clear.title',
    description: 'account.lifecycle.clear.description',
    confirmLabel: 'account.lifecycle.clear.confirm',
    pendingLabel: 'account.lifecycle.clear.pending',
    fallbackError: 'account.lifecycle.clear.error'
  },
  signOutEverywhere: {
    title: 'account.lifecycle.signout.title',
    description: 'account.lifecycle.signout.description',
    confirmLabel: 'account.lifecycle.signout.confirm',
    pendingLabel: 'account.lifecycle.signout.pending',
    fallbackError: 'account.lifecycle.signout.error'
  },
  deleteAccount: {
    title: 'account.lifecycle.delete.title',
    description: 'account.lifecycle.delete.description',
    confirmLabel: 'account.lifecycle.delete.confirm',
    pendingLabel: 'account.lifecycle.delete.pending',
    fallbackError: 'account.lifecycle.delete.error'
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
  const { t } = useLocalization();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copy = confirmationCopy[action];
  const avatarBlocked = action === 'deleteAccount' && isAvatarDeletionRequired(error);
  const errorMessage = avatarBlocked
    ? t('account.lifecycle.avatar_blocked')
    : action === 'deleteAccount' && error instanceof ApiError && error.status === 409
      ? t('account.lifecycle.delete.creator_blocked')
      : error
        ? t(copy.fallbackError)
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
        <p className={styles.dialogEyebrow}>{t('account.lifecycle.confirm_eyebrow')}</p>
        <h3 className={styles.dialogTitle} id="account-lifecycle-confirmation-title">{t(copy.title)}</h3>
        <p className={styles.dialogCopy} id="account-lifecycle-confirmation-description">{t(copy.description)}</p>
        {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
        <div className={styles.dialogActions}>
          <button
            className={styles.cancelButton}
            disabled={pending}
            onClick={onCancel}
            ref={cancelButton}
            type="button"
          >
            {t('account.lifecycle.cancel')}
          </button>
          <button
            aria-label={action === 'signOutEverywhere' ? t('account.lifecycle.signout_aria') : undefined}
            className={styles.confirmButton}
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? t(copy.pendingLabel) : t(copy.confirmLabel)}
          </button>
        </div>
      </section>
    </div>
  );
};

/** Presents recoverable account lifecycle controls without owning or stopping playback. */
export const AccountLifecyclePanel = ({ viewerId }: AccountLifecyclePanelProps) => {
  const { t } = useLocalization();
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
      setNotice(t('account.lifecycle.clear.success'));
      void queryClient.invalidateQueries({ queryKey: ['listener', 'home', actedViewerId] });
      void queryClient.invalidateQueries({ queryKey: ['listener', 'library', actedViewerId] });
    }
  });
  const signOutEverywhere = useMutation({
    mutationFn: signOutAccountEverywhere,
    onSuccess: (guard, actedViewerId) => finishSessionExit(
      actedViewerId,
      guard,
      t('account.lifecycle.signout.success')
    )
  });
  const deleteAccount = useMutation({
    mutationFn: deleteListenerAccount,
    onSuccess: (guard, actedViewerId) => finishSessionExit(
      actedViewerId,
      guard,
      t('account.lifecycle.delete.success')
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
        <p className={styles.eyebrow}>{t('account.lifecycle.eyebrow')}</p>
        <h2 className={styles.heading} id="account-lifecycle-heading">{t('account.lifecycle.heading')}</h2>
      </div>

      {visibleNotice && <p className={styles.status} role="status">{visibleNotice}</p>}

      <div className={styles.actionList}>
        <div className={styles.actionRow}>
          <div>
            <h3>{t('account.lifecycle.history.title')}</h3>
            <p>{t('account.lifecycle.history.copy')}</p>
          </div>
          <button className={styles.secondaryButton} onClick={(event) => openConfirmation('clearHistory', event)} type="button">
            {t('account.lifecycle.history.action')}
          </button>
        </div>

        <div className={styles.actionRow}>
          <div>
            <h3>{t('account.lifecycle.devices.title')}</h3>
            <p>{t('account.lifecycle.devices.copy')}</p>
          </div>
          <button className={styles.secondaryButton} onClick={(event) => openConfirmation('signOutEverywhere', event)} type="button">
            {t('account.lifecycle.signout.confirm')}
          </button>
        </div>

        <div className={`${styles.actionRow} ${styles.dangerRow}`}>
          <div>
            <h3>{t('account.lifecycle.delete_row.title')}</h3>
            <p>{t('account.lifecycle.delete_row.copy')}</p>
          </div>
          <button className={styles.dangerButton} onClick={(event) => openConfirmation('deleteAccount', event)} type="button">
            {t('account.lifecycle.delete_row.action')}
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
