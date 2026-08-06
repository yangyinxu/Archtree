import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { accountSessionsQueryKey, changeAccountPassword } from '../../api/account';
import {
  captureAccountOperation,
  isAccountOperationCurrent,
  type AccountOperationGuard
} from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import type { BrowserSession } from '../../api/schemas';
import { browserSessionQuery, browserSessionQueryKey } from '../../api/session';
import styles from './AccountSurfaces.module.css';
import { AuthFormFeedback } from './AuthFormSupport';

/** Sets or changes a password while keeping the current browser session active. */
export const ChangePasswordPage = () => {
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const [localError, setLocalError] = useState('');
  const [status, setStatus] = useState('');
  const activeGuard = useRef<AccountOperationGuard | undefined>(undefined);
  const localOwner = useRef(session.data?.user.id);
  const ownsLocalState = localOwner.current === session.data?.user.id;
  const hasPassword = session.data?.user.authenticationMethods?.includes('password') ?? true;
  const changePassword = useMutation({
    mutationFn: ({ viewerId, input }: {
      viewerId: string;
      input: Parameters<typeof changeAccountPassword>[1];
    }) => changeAccountPassword(viewerId, input),
    onMutate: ({ viewerId }) => {
      const guard = captureAccountOperation(viewerId);
      activeGuard.current = guard;
      return guard;
    },
    onSuccess: (_result, { viewerId }, guard) => {
      if (!isAccountOperationCurrent(guard, session.data?.user.id) || viewerId !== session.data?.user.id) return;
      setStatus('Password updated. Every other signed-in device has been logged out.');
      if (session.data?.user.id === viewerId) {
        queryClient.setQueryData<BrowserSession | null>(browserSessionQueryKey, (current) => current
          ? {
              user: {
                ...current.user,
                authenticationMethods: Array.from(new Set([
                  ...(current.user.authenticationMethods ?? []),
                  'password' as const
                ]))
              }
            }
          : current);
        void queryClient.invalidateQueries({ queryKey: accountSessionsQueryKey(viewerId) });
      }
    }
  });

  useEffect(() => {
    localOwner.current = session.data?.user.id;
    activeGuard.current = undefined;
    setLocalError('');
    setStatus('');
    changePassword.reset();
  }, [session.data?.user.id]);

  if (session.isPending) {
    return <div className={styles.page}><section className={styles.panel}><h1 className={styles.panelTitle}>Checking your account…</h1></section></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>Password settings are temporarily unavailable</h1>
          <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => session.refetch()} type="button">Try again</button>
        </section>
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>Log in to manage your password</h1>
          <Link className={styles.primaryLink} state={{ from: '/account/password' }} to="/login">Log in</Link>
        </section>
      </div>
    );
  }

  const viewerId = session.data.user.id;
  const mutationIsCurrent = isAccountOperationCurrent(activeGuard.current, viewerId);
  const mutationError = mutationIsCurrent && changePassword.error instanceof ApiError
    ? changePassword.error.message
    : mutationIsCurrent && changePassword.isError
      ? 'Finitude could not update your password.'
      : '';

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>Account security</p>
      <h1 className={styles.pageTitle}>{hasPassword ? 'Change password' : 'Set a password'}</h1>
      <p className={styles.lede}>Your current browser stays logged in. Every other active session is revoked after the change.</p>
      <p className={styles.backLink}><Link className={styles.inlineLink} to="/account">← Back to Account</Link></p>
      <form
        key={viewerId}
        aria-busy={changePassword.isPending}
        className={`${styles.formCard} ${styles.accountForm}`}
        onSubmit={(event) => {
          event.preventDefault();
          setLocalError('');
          setStatus('');
          changePassword.reset();
          const form = new FormData(event.currentTarget);
          const newPassword = String(form.get('newPassword') ?? '');
          if (newPassword !== String(form.get('confirmPassword') ?? '')) {
            setLocalError('The passwords do not match.');
            return;
          }
          changePassword.mutate({
            viewerId,
            input: {
              currentPassword: hasPassword ? String(form.get('currentPassword') ?? '') : undefined,
              newPassword
            }
          });
        }}
      >
        <AuthFormFeedback
          error={(ownsLocalState ? localError : '') || mutationError}
          status={ownsLocalState ? status : ''}
          focusKey={changePassword.submittedAt}
        />
        {hasPassword && (
          <div className={styles.field}>
            <label htmlFor="current-password">Current password</label>
            <input autoComplete="current-password" id="current-password" maxLength={256} name="currentPassword" required type="password" />
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="new-password">New password</label>
          <input aria-describedby="change-password-hint" autoComplete="new-password" id="new-password" maxLength={256} minLength={12} name="newPassword" required type="password" />
          <p className={styles.fieldHint} id="change-password-hint">Use 12–256 characters and avoid common passwords.</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="confirm-new-password">Confirm new password</label>
          <input autoComplete="new-password" id="confirm-new-password" maxLength={256} minLength={12} name="confirmPassword" required type="password" />
        </div>
        <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={changePassword.isPending} type="submit">
          {changePassword.isPending ? 'Updating password…' : hasPassword ? 'Change password' : 'Set password'}
        </button>
      </form>
    </div>
  );
};
