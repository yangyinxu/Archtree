import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';

import { browserAuthenticationCapabilitiesQuery } from '../../api/account';
import { isAccountOperationCurrent } from '../../api/accountEpoch';
import { ApiError } from '../../api/client';
import {
  browserSessionQuery,
  browserSessionQueryKey,
  loginBrowserSession
} from '../../api/session';
import { Icon } from '../../components/Icon';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';
import { AuthFormFeedback, noticeFromRouteState } from './AuthFormSupport';

const safeDestination = (state: unknown, query: string) => {
  const fromState = state && typeof state === 'object' && 'from' in state
    ? (state as { from?: unknown }).from
    : undefined;
  const candidate = fromState ?? new URLSearchParams(query).get('returnTo');
  if (typeof candidate !== 'string'
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')) return '/';
  if (candidate === '/content/manage'
    || candidate.startsWith('/content/manage?')
    || candidate.startsWith('/content/manage/')) return candidate;
  const listenerPath = candidate.replace(/^\/finitude(?=\/|$)/, '') || '/';
  const allowedListenerPath = /^\/(?:$|search(?:[/?#]|$)|library(?:[/?#]|$)|playlists(?:[/?#]|$)|albums\/(?:[^/?#]+)(?:[?#]|$)|artists\/(?:[^/?#]+)(?:[?#]|$)|account(?:[/?#]|$))/.test(listenerPath);
  return allowedListenerPath ? listenerPath : '/';
};

/** Submits credentials only to the same-origin cookie session contract. */
export const LoginPage = () => {
  const { t } = useLocalization();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const capabilities = useQuery(browserAuthenticationCapabilitiesQuery());
  const login = useMutation({
    mutationFn: loginBrowserSession,
    onSuccess: ({ session: data, guard }) => {
      if (!isAccountOperationCurrent(guard)) return;
      // Removing all server-state prevents a previous identity from flashing after account change.
      queryClient.clear();
      queryClient.setQueryData(browserSessionQueryKey, data);
      void queryClient.invalidateQueries({ queryKey: ['listener', 'home'] });
    }
  });

  useEffect(() => {
    const loggedInViewer = login.data?.session.user.id;
    // Navigation follows the authoritative session query, so a stale login
    // response cannot redirect a tab that has already reconciled to another viewer.
    if (!login.isSuccess || !loggedInViewer || session.data?.user.id !== loggedInViewer) return;
    const destination = safeDestination(location.state, location.search);
    if (destination === '/content/manage' || destination.startsWith('/content/manage/')) {
      window.location.assign(destination);
    } else {
      navigate(destination, { replace: true });
    }
  }, [
    location.search,
    location.state,
    login.data?.session.user.id,
    login.isSuccess,
    navigate,
    session.data?.user.id
  ]);

  if (session.data) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <div>
            <span className={styles.panelIcon}><Icon name="account" /></span>
            <h1 className={styles.panelTitle}>{t('auth.login.already_listening', { name: session.data.user.displayName || session.data.user.email })}</h1>
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={() => navigate('/')}>{t('account.common.return_home')}</button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const errorMessage = login.isError ? t('auth.login.error') : '';
  const verificationRequired = login.error instanceof ApiError && login.error.status === 403;
  const routeNotice = noticeFromRouteState(location.state);

  return (
    <div className={styles.page}>
      <div className={styles.authLayout}>
        <div>
          <p className={styles.eyebrow}>{t('auth.login.eyebrow')}</p>
          <h1 className={styles.pageTitle}>{t('auth.login.title')}</h1>
          <p className={styles.lede}>{t('auth.login.lede')}</p>
        </div>

        <form
          aria-busy={login.isPending}
          className={styles.formCard}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            login.mutate({
              identifier: String(form.get('identifier') ?? ''),
              password: String(form.get('password') ?? '')
            });
          }}
        >
          <h2 className={styles.formTitle}>{t('auth.login.form_title')}</h2>
          <AuthFormFeedback error={errorMessage} status={login.isError ? '' : routeNotice} focusKey={login.submittedAt} />
          {verificationRequired && (
            <p className={styles.assistiveAction}>
              <Link
                className={styles.inlineLink}
                state={{
                  email: login.variables?.identifier.includes('@')
                    ? login.variables.identifier
                    : undefined
                }}
                to="/verify-email"
              >
                {t('auth.login.verify_prompt')}
              </Link>
            </p>
          )}
          <div className={styles.field}>
            <label htmlFor="login-identifier">{t('account.field.email_or_username')}</label>
            <input autoComplete="username" id="login-identifier" maxLength={254} name="identifier" required type="text" />
          </div>
          <div className={styles.field}>
            <label htmlFor="login-password">{t('account.field.password')}</label>
            <input autoComplete="current-password" id="login-password" name="password" required type="password" />
          </div>
          <button className={`${styles.button} ${styles.buttonPrimary}`} disabled={login.isPending} type="submit">
            {login.isPending ? t('auth.login.logging_in') : t('common.action.log_in')}
          </button>
          <div className={styles.authLinkRow}>
            <Link className={styles.inlineLink} to="/forgot-password">{t('auth.login.forgot_password')}</Link>
            {capabilities.data?.emailRegistration && (
              <Link className={styles.inlineLink} to="/register">{t('auth.login.create_account')}</Link>
            )}
          </div>
          <p className={styles.privacy}>{t('auth.login.privacy')}</p>
        </form>
      </div>
    </div>
  );
};
