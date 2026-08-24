import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';

import { isAccountOperationCurrent } from '../../api/accountEpoch';
import {
  browserSessionQuery,
  browserSessionQueryKey,
  logoutBrowserSession
} from '../../api/session';
import { Icon } from '../../components/Icon';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { clearSearchHistory } from '../search/searchHistory';
import { AccountLifecyclePanel } from './AccountLifecyclePanel';
import { AvatarSettings } from './avatar';
import styles from './AccountSurfaces.module.css';

/** Converts safe method identifiers into familiar account labels. */
const methodLabelKeys: Record<string, MessageKey> = {
  password: 'account.method.password',
  apple: 'account.method.apple',
  google: 'account.method.google',
  passkey: 'account.method.passkey'
};

/** Presents authoritative identity and clears account-scoped query state on logout. */
export const AccountPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const hasPassword = session.data?.user.authenticationMethods?.includes('password') ?? true;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => {
      const viewerId = session.data?.user.id;
      if (!viewerId) throw new Error('A current account is required to sign out.');
      return logoutBrowserSession(viewerId);
    },
    onSuccess: (guard) => {
      if (!isAccountOperationCurrent(guard)) return;
      clearSearchHistory(session.data?.user.id);
      queryClient.clear();
      queryClient.setQueryData(browserSessionQueryKey, null);
      navigate('/', { replace: true });
    }
  });

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>{t('account.page.eyebrow')}</p>
      <h1 className={styles.pageTitle}>{t('account.page.title')}</h1>

      <section className={styles.panel} aria-live="polite">
        {session.isPending ? (
          <div><h2 className={styles.panelTitle}>{t('account.common.checking')}</h2></div>
        ) : session.isError ? (
          <div>
            <h2 className={styles.panelTitle}>{t('account.page.unavailable_title')}</h2>
            <p className={styles.panelCopy}>{t('account.page.unavailable_copy')}</p>
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => session.refetch()} type="button">{t('common.action.try_again')}</button>
            </div>
          </div>
        ) : !session.data ? (
          <div>
            <span className={styles.panelIcon}><Icon name="account" /></span>
            <h2 className={styles.panelTitle}>{t('account.page.signed_out_title')}</h2>
            <div className={styles.actions}><Link className={styles.primaryLink} to="/login">{t('common.action.log_in')}</Link></div>
          </div>
        ) : (
          <div className={styles.accountContent}>
            <AvatarSettings user={session.data.user} />
            <div className={styles.identityRow}>
              <div>
                <p className={styles.identityTitle}>{session.data.user.displayName || t('account.page.listener_fallback')}</p>
                <p className={styles.identityMeta}>{session.data.user.email}</p>
              </div>
            </div>
            <dl className={styles.accountDetails}>
              <div className={styles.accountDetail}>
                <dt>{t('account.field.name')}</dt>
                <dd>{session.data.user.displayName || t('account.page.not_set')}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>{t('account.field.email')}</dt>
                <dd>{session.data.user.email}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>{t('account.page.status')}</dt>
                <dd>{session.data.user.emailVerified ? t('account.page.email_verified') : t('account.page.verification_required')}</dd>
              </div>
              <div className={styles.accountDetail}>
                <dt>{t('account.page.sign_in_methods')}</dt>
                <dd>{(session.data.user.authenticationMethods?.length
                  ? session.data.user.authenticationMethods
                  : ['password']).map((method) => methodLabelKeys[method] ? t(methodLabelKeys[method]) : method).join(', ')}</dd>
              </div>
            </dl>
            {!session.data.user.emailVerified && (
              <Link className={styles.inlineLink} state={{ email: session.data.user.email }} to="/verify-email">{t('account.page.verify_email')}</Link>
            )}
            <nav aria-label={t('account.page.settings_label')} className={styles.settingsList}>
              <Link className={styles.settingsLink} to="/account/sessions">
                <span>{t('account.page.signed_in_devices')}</span><span aria-hidden="true">›</span>
              </Link>
              <Link className={styles.settingsLink} to="/account/password">
                <span>{hasPassword ? t('account.page.change_password') : t('account.page.set_password')}</span><span aria-hidden="true">›</span>
              </Link>
            </nav>
            {logout.isError && (
              <p className={styles.error} role="alert">
                {t('account.page.logout_error')}
              </p>
            )}
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} disabled={logout.isPending} type="button" onClick={() => logout.mutate()}>
                {logout.isPending ? t('account.page.logging_out') : t('account.page.log_out')}
              </button>
            </div>
          </div>
        )}
      </section>

      {session.data && <AccountLifecyclePanel viewerId={session.data.user.id} />}
    </div>
  );
};
