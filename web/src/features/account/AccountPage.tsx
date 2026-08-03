import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';

import { ApiError } from '../../api/client';
import {
  browserSessionQuery,
  browserSessionQueryKey,
  logoutBrowserSession
} from '../../api/session';
import { Icon } from '../../components/Icon';
import { clearSearchHistory } from '../search/searchHistory';
import { AccountLifecyclePanel } from './AccountLifecyclePanel';
import { AvatarSettings } from './avatar';
import styles from '../../styles/Pages.module.css';

/** Converts safe method identifiers into familiar account labels. */
const methodLabel = (method: string) => ({
  password: 'Password',
  apple: 'Apple',
  google: 'Google',
  passkey: 'Passkey'
}[method] ?? method);

/** Presents authoritative identity and clears account-scoped query state on logout. */
export const AccountPage = () => {
  const session = useQuery(browserSessionQuery());
  const hasPassword = session.data?.user.authenticationMethods?.includes('password') ?? true;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => logoutBrowserSession(session.data?.user.id),
    onSuccess: () => {
      clearSearchHistory(session.data?.user.id);
      queryClient.clear();
      queryClient.setQueryData(browserSessionQueryKey, null);
      navigate('/', { replace: true });
    }
  });

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>Listening identity</p>
      <h1 className={styles.pageTitle}>Account</h1>

      <section className={styles.panel} aria-live="polite">
        {session.isPending ? (
          <div><h2 className={styles.panelTitle}>Checking your account…</h2></div>
        ) : session.isError ? (
          <div>
            <h2 className={styles.panelTitle}>Your account is temporarily unavailable</h2>
            <p className={styles.panelCopy}>Finitude could not safely confirm whether you are logged in.</p>
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => session.refetch()} type="button">Try again</button>
            </div>
          </div>
        ) : !session.data ? (
          <div>
            <span className={styles.panelIcon}><Icon name="account" /></span>
            <h2 className={styles.panelTitle}>You are not logged in</h2>
            <div className={styles.actions}><Link className={styles.primaryLink} to="/login">Log in</Link></div>
          </div>
        ) : (
          <div className={styles.accountContent}>
            <AvatarSettings user={session.data.user} />
            <div className={styles.identityRow}>
              <div>
                <p className={styles.identityTitle}>{session.data.user.displayName || 'Finitude listener'}</p>
                <p className={styles.identityMeta}>{session.data.user.email}</p>
              </div>
            </div>
            <dl className={styles.accountDetails}>
              <div className={styles.accountDetail}>
                <dt>Name</dt>
                <dd>{session.data.user.displayName || 'Not set'}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>Email</dt>
                <dd>{session.data.user.email}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>Status</dt>
                <dd>{session.data.user.emailVerified ? 'Email verified' : 'Verification required'}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>Sign-in methods</dt>
                <dd>{(session.data.user.authenticationMethods?.length
                  ? session.data.user.authenticationMethods
                  : ['password']).map(methodLabel).join(', ')}</dd>
              </div>
            </dl>
            {!session.data.user.emailVerified && (
              <Link className={styles.inlineLink} state={{ email: session.data.user.email }} to="/verify-email">Verify email</Link>
            )}
            <nav aria-label="Account settings" className={styles.settingsList}>
              <Link className={styles.settingsLink} to="/account/sessions">
                <span>Signed-in devices</span><span aria-hidden="true">›</span>
              </Link>
              <Link className={styles.settingsLink} to="/account/password">
                <span>{hasPassword ? 'Change password' : 'Set a password'}</span><span aria-hidden="true">›</span>
              </Link>
            </nav>
            {logout.isError && (
              <p className={styles.error} role="alert">
                {logout.error instanceof ApiError ? logout.error.message : 'Finitude could not log out. Please try again.'}
              </p>
            )}
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} disabled={logout.isPending} type="button" onClick={() => logout.mutate()}>
                {logout.isPending ? 'Logging out…' : 'Log out'}
              </button>
            </div>
          </div>
        )}
      </section>

      {session.data && <AccountLifecyclePanel viewerId={session.data.user.id} />}
    </div>
  );
};
