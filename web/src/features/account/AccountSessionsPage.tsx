import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router';

import {
  accountSessionsQuery,
  accountSessionsQueryKey,
  revokeAccountSession
} from '../../api/account';
import { browserSessionQuery } from '../../api/session';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './AccountSurfaces.module.css';

/** Lets a listener review and revoke other sessions without displaying raw User-Agent strings. */
export const AccountSessionsPage = () => {
  const { locale, t } = useLocalization();
  const timestamp = useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }), [locale]);
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const sessions = useQuery(accountSessionsQuery(viewerId));
  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeAccountSession(viewerId, sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountSessionsQueryKey(viewerId) })
  });

  if (session.isPending) {
    return <div className={styles.page}><section className={styles.panel}><h1 className={styles.panelTitle}>{t('account.common.checking')}</h1></section></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>{t('account.sessions.unavailable')}</h1>
          <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => session.refetch()} type="button">{t('common.action.try_again')}</button>
        </section>
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>{t('account.sessions.login_required')}</h1>
          <Link className={styles.primaryLink} state={{ from: '/account/sessions' }} to="/login">{t('common.action.log_in')}</Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>{t('account.sessions.eyebrow')}</p>
      <h1 className={styles.pageTitle}>{t('account.sessions.title')}</h1>
      <p className={styles.lede}>{t('account.sessions.lede')}</p>
      <p className={styles.backLink}><Link className={styles.inlineLink} to="/account">{t('account.common.back_account')}</Link></p>
      {sessions.isPending ? (
        <section className={styles.compactState} aria-live="polite">{t('account.sessions.loading')}</section>
      ) : sessions.isError ? (
        <section className={styles.compactState}>
          <p role="alert">{t('account.sessions.load_error')}</p>
          <button className={styles.textButton} onClick={() => sessions.refetch()} type="button">{t('common.action.try_again')}</button>
        </section>
      ) : (
        <ul className={styles.sessionList} aria-label={t('account.sessions.list_label')}>
          {sessions.data.sessions.map((item) => (
            <li className={styles.sessionItem} key={item.id}>
              <div>
                <h2 className={styles.sessionName}>{item.deviceName}</h2>
                <p className={styles.sessionMeta}>
                  {item.isCurrent ? t('account.sessions.this_device') : t('account.sessions.last_active', { timestamp: timestamp.format(new Date(item.lastUsedAt)) })}
                </p>
              </div>
              {item.isCurrent ? (
                <span className={styles.currentBadge}>{t('account.sessions.current')}</span>
              ) : (
                <button
                  className={`${styles.button} ${styles.buttonSecondary}`}
                  disabled={revoke.isPending && revoke.variables === item.id}
                  onClick={() => revoke.mutate(item.id)}
                  type="button"
                >
                  {revoke.isPending && revoke.variables === item.id ? t('account.sessions.removing') : t('account.sessions.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && (
        <p className={styles.error} role="alert">
          {t('account.sessions.remove_error')}
        </p>
      )}
    </div>
  );
};
