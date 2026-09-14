import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSocialPage } from '../../api/social';
import { getListeningStatuses } from '../../api/listening';
import { useLocalization } from '../../localization/LocalizationProvider';
import { listeningSession } from './listeningSession';
import styles from './SocialPage.module.css';

const InviteListeningFriend = lazy(() => import('./InviteListeningFriend').then(module => ({ default: module.InviteListeningFriend })));

/** Only the visible friend panel polls; query identities and expiry prevent cached private status from lingering. */
export const FriendsListening = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const panel = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const [monotonic, setMonotonic] = useState(() => performance.now());
  useEffect(() => {
    const visibility = () => { setVisible(document.visibilityState !== 'hidden'); setMonotonic(performance.now()); };
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)));
    if (panel.current) observer?.observe(panel.current);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const active = inView && visible;
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const friends = useQuery({ queryKey: ['social', viewerId, 'relationships', 'friends', 'listening-page', cursor],
    queryFn: ({ signal }) => getSocialPage(viewerId, 'friends', cursor, signal), enabled: active, staleTime: 15_000, retry: false });
  const rows = friends.isError ? [] : friends.data?.items.filter(row => row.profile) ?? [];
  const ids = rows.map(row => row.socialId).sort();
  const statuses = useQuery({ queryKey: ['social', viewerId, 'listening-status', ...ids],
    queryFn: async ({ signal }) => {
      if (!listeningSession.getClock(viewerId)) await listeningSession.refresh();
      const clock = listeningSession.getClock(viewerId);
      if (!clock) throw new Error('Listening clock is unavailable.');
      const groups = [];
      for (let offset = 0; offset < ids.length; offset += 50) groups.push(await getListeningStatuses(viewerId, ids.slice(offset, offset + 50), signal));
      return { items: groups.flatMap(group => group.items), clock };
    }, enabled: active && ids.length > 0, refetchInterval: active ? 5000 : false,
    refetchOnWindowFocus: 'always', retry: false });
  useEffect(() => {
    if (!active || !statuses.data) return;
    setMonotonic(performance.now());
    const timer = setInterval(() => setMonotonic(performance.now()), 500);
    return () => clearInterval(timer);
  }, [active, statuses.data]);
  const data = !statuses.isError && !friends.isError && active ? statuses.data : undefined;
  const serverNow = data ? data.clock.server + Math.max(monotonic, performance.now()) - data.clock.mono : Infinity;
  const items = data?.items.filter(item => item.expiresAtMs > serverNow && rows.some(row => row.socialId === item.peer.socialId)) ?? [];
  return <section className={styles.panel} ref={panel} aria-label={t('listening.title')}>
    <h2>{t('listening.title')}</h2>
    {(friends.isError || statuses.isError) && <p role="alert" className={styles.error}>{t('social.error')}</p>}
    {active && (friends.isLoading || ids.length > 0 && statuses.isLoading) ? <p role="status">{t('social.loading')}</p>
      : !items.length ? <p className={styles.empty}>{t('listening.empty')}</p> : <ul className={styles.list} aria-label={t('listening.title')}>
        {items.map(item => {
          // The status read rechecks current friendship and projects its current social card.
          const peer = item.peer;
          return <li className={`${styles.row} ${styles.invitationRow}`} key={peer.socialId}>
            <div className={styles.rowContent}><strong>{t('listening.now', { alias: peer.alias })}</strong><span>{item.track.title}</span><span>{item.track.artistNames.join(', ')}</span><div className={styles.actions}>
            <Suspense fallback={null}><InviteListeningFriend viewerId={viewerId} item={item} expiresInMs={item.expiresAtMs - serverNow} /></Suspense>
            </div></div>
          </li>;
        })}
      </ul>}
    <div className={styles.actions}><button className={styles.secondary} disabled={!active || statuses.isFetching || friends.isFetching} onClick={() => { if (friends.isError || !friends.data || Date.now() - friends.dataUpdatedAt >= 15_000) void friends.refetch(); if (ids.length) void statuses.refetch(); }}>{t('listening.refresh')}</button>
      {cursors.length > 1 && <button className={styles.secondary} disabled={!active || friends.isFetching} onClick={() => setCursors(value => value.slice(0, -1))}>{t('page_section.carousel.previous', { title: t('listening.title') })}</button>}
      {friends.data?.nextCursor && <button className={styles.secondary} disabled={!active || friends.isFetching} onClick={() => setCursors(value => [...value, friends.data!.nextCursor!])}>{t('page_section.carousel.next', { title: t('listening.title') })}</button>}
    </div>
  </section>;
};
