import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  accountSessionsQuery,
  accountSessionsQueryKey,
  revokeAccountSession
} from '../../api/account';
import { ApiError } from '../../api/client';
import { browserSessionQuery } from '../../api/session';
import styles from './AccountSurfaces.module.css';

const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
});

/** Lets a listener review and revoke other sessions without displaying raw User-Agent strings. */
export const AccountSessionsPage = () => {
  const queryClient = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id ?? '';
  const sessions = useQuery(accountSessionsQuery(viewerId));
  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeAccountSession(viewerId, sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountSessionsQueryKey(viewerId) })
  });

  if (session.isPending) {
    return <div className={styles.page}><section className={styles.panel}><h1 className={styles.panelTitle}>Checking your account…</h1></section></div>;
  }
  if (session.isError) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>Signed-in devices are temporarily unavailable</h1>
          <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => session.refetch()} type="button">Try again</button>
        </section>
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <h1 className={styles.panelTitle}>Log in to manage signed-in devices</h1>
          <Link className={styles.primaryLink} state={{ from: '/account/sessions' }} to="/login">Log in</Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>Account security</p>
      <h1 className={styles.pageTitle}>Signed-in devices</h1>
      <p className={styles.lede}>Review active Finitude sessions and remove any device you no longer use.</p>
      <p className={styles.backLink}><Link className={styles.inlineLink} to="/account">← Back to Account</Link></p>
      {sessions.isPending ? (
        <section className={styles.compactState} aria-live="polite">Loading signed-in devices…</section>
      ) : sessions.isError ? (
        <section className={styles.compactState}>
          <p role="alert">Finitude could not load your devices.</p>
          <button className={styles.textButton} onClick={() => sessions.refetch()} type="button">Try again</button>
        </section>
      ) : (
        <ul className={styles.sessionList} aria-label="Active sessions">
          {sessions.data.sessions.map((item) => (
            <li className={styles.sessionItem} key={item.id}>
              <div>
                <h2 className={styles.sessionName}>{item.deviceName}</h2>
                <p className={styles.sessionMeta}>
                  {item.isCurrent ? 'This device' : `Last active ${timestamp.format(new Date(item.lastUsedAt))}`}
                </p>
              </div>
              {item.isCurrent ? (
                <span className={styles.currentBadge}>Current</span>
              ) : (
                <button
                  className={`${styles.button} ${styles.buttonSecondary}`}
                  disabled={revoke.isPending && revoke.variables === item.id}
                  onClick={() => revoke.mutate(item.id)}
                  type="button"
                >
                  {revoke.isPending && revoke.variables === item.id ? 'Removing…' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && (
        <p className={styles.error} role="alert">
          {revoke.error instanceof ApiError ? revoke.error.message : 'Finitude could not remove that device.'}
        </p>
      )}
    </div>
  );
};
