import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getListeningFriends, type FriendListeningStatus } from '../../api/listening';
import { Artwork } from '../../components/Artwork';
import { useLocalization } from '../../localization/LocalizationProvider';
import { listeningSession } from './listeningSession';
import styles from './SocialPage.module.css';

const InviteListeningFriend = lazy(() => import('./InviteListeningFriend').then(module => ({ default: module.InviteListeningFriend })));
type ListeningClock = { server: number; mono: number };
const pollMs = 5000;

/**
 * Shows every friend who is listening now, across the whole friend list: the server pages listening friends
 * directly, so a friend beyond the first 20 friends is not hidden. The list is read when Together opens, not when
 * the panel is first seen: growing on first sight pushed the profile controls below it out from under the pointer
 * or keyboard focus, and the unread panel claimed nobody was listening. Only the panel in view polls (every loaded
 * page is refetched together) and returning to it refreshes a read older than one poll. A hidden document neither
 * reads nor shows status; query identities and local expiry keep cached private status from lingering.
 */
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
  const polling = inView && visible;
  const statuses = useInfiniteQuery({ queryKey: ['social', viewerId, 'listening-friends'],
    queryFn: async ({ pageParam, signal }) => {
      if (!listeningSession.getClock(viewerId)) await listeningSession.refresh();
      const clock: ListeningClock | null = listeningSession.getClock(viewerId);
      if (!clock) throw new Error('Listening clock is unavailable.');
      // Each page keeps the owner clock observed with it, so expiry never mixes server time from different reads.
      return { ...await getListeningFriends(viewerId, pageParam, signal), clock };
    }, initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: visible, refetchInterval: polling ? pollMs : false, refetchOnWindowFocus: polling ? 'always' : false, retry: false });
  const { data, dataUpdatedAt, refetch } = statuses;
  useEffect(() => {
    // A restarted interval would first poll a full period later, so a read older than that is refreshed now.
    if (polling && data && Date.now() - dataUpdatedAt >= pollMs) void refetch({ cancelRefetch: false });
  }, [polling, data, dataUpdatedAt, refetch]);
  const shown = visible && !statuses.isError;
  useEffect(() => {
    // Statuses stay in the document while scrolled away, so they expire there too.
    if (!shown || !data) return;
    setMonotonic(performance.now());
    const timer = setInterval(() => setMonotonic(performance.now()), 500);
    return () => clearInterval(timer);
  }, [shown, data]);
  const pages = shown ? data?.pages ?? [] : [];
  const serverNow = (clock: ListeningClock) => clock.server + Math.max(monotonic, performance.now()) - clock.mono;
  // A friend can move between pages while they are fetched in sequence; the first fresh occurrence wins.
  const seen = new Set<string>();
  const items: { item: FriendListeningStatus; expiresInMs: number }[] = [];
  for (const page of pages) for (const item of page.items) {
    const expiresInMs = item.expiresAtMs - serverNow(page.clock);
    if (expiresInMs <= 0 || seen.has(item.peer.socialId)) continue;
    seen.add(item.peer.socialId); items.push({ item, expiresInMs });
  }
  return <section className={styles.panel} ref={panel} aria-label={t('listening.title')}>
    <h2>{t('listening.title')}</h2>
    {statuses.isError && <p role="alert" className={styles.error}>{t('social.error')}</p>}
    {statuses.isLoading ? <p role="status">{t('social.loading')}</p>
      : !items.length ? <p className={styles.empty}>{t('listening.empty')}</p> : <ul className={styles.list} aria-label={t('listening.title')}>
        {items.map(({ item, expiresInMs }) => {
          // The server rechecks current friendship on every read and projects the friend's current social card.
          const peer = item.peer;
          return <li className={`${styles.row} ${styles.listeningItem}`} key={peer.socialId}>
            <Artwork className={styles.artwork} alt="" kind="audioTrack" sizes="4rem" src={item.track.artworkUrl} />
            <div className={styles.rowContent}><strong>{t('listening.now', { alias: peer.alias })}</strong><span>{item.track.title}</span><span>{item.track.artistNames.join(', ')}</span><div className={styles.actions}>
            <Suspense fallback={null}><InviteListeningFriend viewerId={viewerId} item={item} expiresInMs={expiresInMs} /></Suspense>
            </div></div>
          </li>;
        })}
      </ul>}
    <div className={styles.actions}><button className={styles.secondary} disabled={!visible || statuses.isFetching} onClick={() => void refetch()}>{t('listening.refresh')}</button>
      {shown && statuses.hasNextPage && <button className={styles.secondary} disabled={statuses.isFetching} onClick={() => void statuses.fetchNextPage()}>{t('common.action.load_more')}</button>}
    </div>
  </section>;
};
