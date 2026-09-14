import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialProfile } from '../../api/social';
import { getMusicShares, type MusicShareDirection, type MusicShareItem } from '../../api/musicShares';
import { saveStatusesQuery } from '../../api/listener';
import { Artwork } from '../../components/Artwork';
import { SaveButton } from '../../components/SaveButton';
import { useLocalization } from '../../localization/LocalizationProvider';
import { MusicShareRecovery, useShareActions } from './MusicShareRecovery';
import { musicShareSession } from './musicShareSession';
import { useInvitationNow } from './useInvitationNow';
import styles from './SocialPage.module.css';

const RoomStatus = lazy(() => import('./MusicShareRoomActions').then(module => ({ default: module.MusicShareRoomStatus })));
const Invite = lazy(() => import('./MusicShareRoomActions').then(module => ({ default: module.MusicShareInvite })));

const ShareList = ({ viewerId, direction }: { viewerId: string; direction: MusicShareDirection }) => {
  const { t } = useLocalization();
  const actions = useShareActions(viewerId);
  const [roomActive, setRoomActive] = useState(false);
  const result = useInfiniteQuery({ queryKey: ['social', viewerId, 'music-shares', direction],
    queryFn: ({ pageParam, signal }) => getMusicShares(viewerId, direction, pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 15_000, refetchOnWindowFocus: 'always', retry: false });
  const allItems = useMemo(() => [...new Map((result.data?.pages ?? []).flatMap(page => page.items).map(item => [item.shareId, item])).values()], [result.data]);
  const nextExpiry = allItems.reduce((next, item) => item.expiresAtMs > Date.now() ? Math.min(next, item.expiresAtMs) : next, Infinity);
  const now = useInvitationNow(Number.isFinite(nextExpiry) ? nextExpiry : undefined);
  const items = result.isError ? [] : allItems.filter(item => item.expiresAtMs > now);
  const visibleItems = useRef(items); visibleItems.current = items;
  const targets = useMemo(() => allItems.filter(item => item.content).map(item => ({ contentType: item.contentType, contentId: item.contentId })), [allItems]);
  const statuses = useQuery(saveStatusesQuery(viewerId, targets));
  const [playing, setPlaying] = useState('');
  const [playError, setPlayError] = useState(false);
  const [roomDetected, setRoomDetected] = useState(false);
  const playSequence = useRef(0);
  useEffect(() => () => { playSequence.current++; }, []);
  const currentShare = (item: MusicShareItem) => visibleItems.current.some(value => value.shareId === item.shareId && value.content && value.expiresAtMs > Date.now());
  const blocked = !actions.ready || actions.busy || Boolean(actions.uncertain);
  const play = async (item: MusicShareItem) => {
    if (!currentShare(item) || roomActive) return;
    const sequence = ++playSequence.current;
    const guard = captureAccountOperation(viewerId);
    const current = () => sequence === playSequence.current && isAccountOperationCurrent(guard, viewerId) && currentShare(item);
    setPlaying(item.shareId); setPlayError(false); setRoomDetected(false);
    try {
      const { playSharedMusic } = await import('./musicSharePlayback');
      const active = await playSharedMusic(viewerId, item, current);
      if (current()) setRoomDetected(active);
    } catch { if (current()) setPlayError(true); }
    finally { if (sequence === playSequence.current && isAccountOperationCurrent(guard, viewerId)) setPlaying(''); }
  };
  return <>
    <MusicShareRecovery viewerId={viewerId} />
    <Suspense fallback={null}><RoomStatus viewerId={viewerId} onRoomChange={setRoomActive} /></Suspense>
    {roomDetected && !roomActive && <p className={styles.status}>{t('music_shares.room_playback')} <Link to="/social">{t('music_shares.open_together')}</Link></p>}
    {playError && <p role="alert">{t('social.error')}</p>}
    {result.isPending ? <p role="status">{t('social.loading')}</p>
      : result.isError ? <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => result.refetch()}>{t('social.refresh')}</button></p>
        : !items.length ? <p className={styles.empty}>{t(direction === 'incoming' ? 'music_shares.empty_received' : 'music_shares.empty_sent')}</p>
          : <ul className={styles.list}>{items.map(item => {
            const saved = statuses.isError ? null : statuses.data?.items.find(value => value.contentType === item.contentType && value.contentId === item.contentId)?.saved ?? null;
            return <li className={styles.row} key={item.shareId}><article className={styles.stack} aria-label={item.content?.title || t('music_shares.unavailable')}>
              <div className={styles.nowPlaying}>
                {item.content ? <Artwork className={styles.artwork} alt="" kind={item.contentType} sizes="4rem" src={item.content.artworkUrl} /> : <span className={styles.artwork} aria-hidden="true">♪</span>}
                <div className={styles.rowContent}><strong>{item.content?.title || t('music_shares.unavailable')}</strong>
                  {item.content && <span>{item.content.artistNames.join(', ')}</span>}
                  <span>{t(direction === 'incoming' ? 'music_shares.from' : 'music_shares.to', { alias: item.peer.alias })}</span>
                </div>
              </div>
              <div className={styles.actions}>
                {item.content && <><button className={styles.button} disabled={roomActive || playing === item.shareId} onClick={() => void play(item)}>{t('common.action.play')}</button>
                  <SaveButton viewerId={viewerId} target={{ contentType: item.contentType, contentId: item.contentId }} saved={saved} />
                  {item.contentType === 'album' && <Link to={`/albums/${item.contentId}`}>{t('common.label.album')}</Link>}</>}
                <button className={styles.secondary} disabled={blocked} onClick={() => {
                  if (item.expiresAtMs > Date.now()) void musicShareSession.run({ action: direction === 'incoming' ? 'dismissMusicShare' : 'withdrawMusicShare', shareId: item.shareId });
                }}>{t(direction === 'incoming' ? 'music_shares.dismiss' : 'music_shares.withdraw')}</button>
                {direction === 'incoming' && <Suspense fallback={null}><Invite viewerId={viewerId} item={item} /></Suspense>}
                {direction === 'incoming' && <Link to="/social">{t('music_shares.open_together')}</Link>}
              </div>
            </article></li>;
          })}</ul>}
    {result.hasNextPage && !result.isError && <button className={styles.secondary} disabled={result.isFetchingNextPage} onClick={() => result.fetchNextPage()}>{t('common.action.load_more')}</button>}
  </>;
};

const SharesAccount = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  useShareActions(viewerId);
  const [direction, setDirection] = useState<MusicShareDirection>('incoming');
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'], queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  return <>
    <div className={styles.tabs} role="group" aria-label={t('music_shares.title')}>{(['incoming', 'outgoing'] as const).map(value => <button key={value} type="button" aria-pressed={direction === value} className={direction === value ? styles.button : styles.secondary} onClick={() => setDirection(value)}>{t(value === 'incoming' ? 'music_shares.received' : 'music_shares.sent')}</button>)}</div>
    {profile.isPending ? <p role="status">{t('social.loading')}</p>
      : profile.isError ? <><MusicShareRecovery viewerId={viewerId} /><p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => profile.refetch()}>{t('social.refresh')}</button></p></>
        : !profile.data?.profile?.active ? <><MusicShareRecovery viewerId={viewerId} /><p>{t('music_shares.no_friends')} <Link to="/social">{t('music_shares.open_together')}</Link></p></>
          : <ShareList key={direction} viewerId={viewerId} direction={direction} />}
  </>;
};

/** Private persistent inbox and sent lists require resolved authentication before any identity is rendered. */
export const MusicSharesPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  return <div className={styles.page}>
    <div className={styles.hero}><div><p className={styles.eyebrow}>Finitude · {t('social.nav')}</p><h1>{t('music_shares.title')}</h1><p className={styles.description}>{t('music_shares.description')}</p></div><Link className={styles.secondary} to="/social">{t('music_shares.open_together')}</Link></div>
    <section className={styles.panel}>{session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p>
      : session.isError ? <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => session.refetch()}>{t('social.refresh')}</button></p>
        : !session.data ? <p>{t('music_shares.sign_in')} <Link to="/login?returnTo=%2Fsocial%2Fshares">{t('common.action.log_in')}</Link></p>
          : <SharesAccount key={session.data.user.id} viewerId={session.data.user.id} />}</section>
  </div>;
};
