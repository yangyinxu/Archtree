import { useRef, useState, type RefObject } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialPage, getSocialProfile } from '../../api/social';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import { musicShareSession } from './musicShareSession';
import { MusicShareRecovery, useShareActions } from './MusicShareRecovery';
import type { ShareMusicButtonProps } from './ShareMusicButton';
import styles from './SocialPage.module.css';

const ShareComposer = ({ viewerId, music, onClose }: { viewerId: string; music: ShareMusicButtonProps; onClose: () => void }) => {
  const { t } = useLocalization();
  const state = useShareActions(viewerId);
  const [selected, setSelected] = useState('');
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'], queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  const friends = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', 'friends'],
    queryFn: ({ pageParam, signal }) => getSocialPage(viewerId, 'friends', pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(profile.data?.profile?.active) && !profile.isError, refetchOnWindowFocus: 'always', retry: false });
  const rows = !friends.isError && !profile.isError && profile.data?.profile?.active
    ? [...new Map(friends.data?.pages.flatMap(page => page.items).filter(row => row.profile).map(row => [row.socialId, row]) ?? []).values()] : [];
  const friend = rows.find(row => row.socialId === selected);
  const unavailable = !state.ready || state.busy || Boolean(state.uncertain);
  return <>
    <MusicShareRecovery viewerId={viewerId} />
    {(profile.isError || friends.isError) && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => { void profile.refetch(); void friends.refetch(); }}>{t('social.refresh')}</button></p>}
    {profile.isPending || profile.data?.profile?.active && friends.isPending ? <p role="status">{t('social.loading')}</p>
      : !rows.length && !profile.isError && !friends.isError ? <p>{t('music_shares.no_friends')} <Link to="/social" onClick={onClose}>{t('music_shares.open_together')}</Link></p> : null}
    <form className={styles.stack} onSubmit={event => {
      event.preventDefault();
      if (!friend || unavailable) return;
      void musicShareSession.run({ action: 'shareMusic', targetSocialId: friend.socialId, expectedRevision: friend.revision,
        contentType: music.contentType, contentId: music.contentId });
    }}>
      <label className={styles.field}>{t('music_shares.choose_friend')}<select value={selected} onChange={event => setSelected(event.target.value)} disabled={unavailable || !rows.length}>
        <option value="">{t('music_shares.choose_friend')}</option>
        {rows.map(row => <option key={row.socialId} value={row.socialId}>{row.profile!.alias} (@{row.profile!.handle})</option>)}
      </select></label>
      {friends.hasNextPage && <button type="button" className={styles.secondary} disabled={friends.isFetchingNextPage} onClick={() => friends.fetchNextPage()}>{t('common.action.load_more')}</button>}
      <button className={styles.button} disabled={unavailable || !friend}>{t('music_shares.send')}</button>
    </form>
    <div className={styles.actions}><Link to="/social/shares" onClick={onClose}>{t('music_shares.title')}</Link></div>
  </>;
};

/** Resolves authentication before private friend reads; closing never abandons an uncertain command. */
export default function ShareMusicDialog({ onClose, returnFocusRef, ...music }: ShareMusicButtonProps & {
  onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>
}) {
  const { t } = useLocalization();
  const close = useRef<HTMLButtonElement>(null);
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  return <ModalDialog title={t('music_shares.share_title', { title: music.title })} initialFocusRef={close} returnFocusRef={returnFocusRef} onClose={onClose}>
    {session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p>
      : session.isError ? <p role="alert">{t('social.error')}</p>
        : !session.data ? <p>{t('music_shares.sign_in')} <Link to="/login?returnTo=%2Fsocial%2Fshares" onClick={onClose}>{t('common.action.log_in')}</Link></p>
          : <ShareComposer key={session.data.user.id} viewerId={session.data.user.id} music={music} onClose={onClose} />}
    <div className={styles.actions}><button className={styles.secondary} type="button" ref={close} onClick={onClose}>{t('common.action.close')}</button></div>
  </ModalDialog>;
}
