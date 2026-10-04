import { lazy, Suspense, useRef, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { RoomTrackButtonProps } from './RoomTrackButton';
import styles from './SocialPage.module.css';

// Authentication and opt-in explanations do not load the active room composer.
const RoomTrackComposer = lazy(() => import('./RoomTrackComposer'));

/** Inactive or unresolved accounts do not mount any room transport, eligibility or friendship reads. */
const ProfileGate = ({ viewerId, track, onClose }: { viewerId: string; track: RoomTrackButtonProps; onClose: () => void }) => {
  const { t } = useLocalization();
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'],
    queryFn: async ({ signal }) => {
      const api = await import('../../api/social'); signal.throwIfAborted();
      return api.getSocialProfile(viewerId, signal);
    }, retry: false });
  return profile.isPending ? <p role="status">{t('social.loading')}</p> : profile.isError
    ? <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => profile.refetch()}>{t('social.refresh')}</button></p>
    : !profile.data?.profile?.active ? <p>{t('room_track.opt_in')} <Link to="/social" onClick={onClose}>{t('music_shares.open_together')}</Link></p>
      : <Suspense fallback={<p role="status">{t('social.loading')}</p>}><RoomTrackComposer viewerId={viewerId} track={track} onClose={onClose} /></Suspense>;
};

/** The entry point explains authentication and opt-in before exposing any private room or friend data. */
export default function RoomTrackDialog({ onClose, returnFocusRef, ...track }: RoomTrackButtonProps & {
  onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useLocalization();
  const close = useRef<HTMLButtonElement>(null);
  const session = useQuery(browserSessionQuery()), resolving = useQuery(browserSessionResolvingQuery());
  return <ModalDialog title={t('room_track.title', { title: track.title })} initialFocusRef={close} returnFocusRef={returnFocusRef} onClose={onClose}>
    {session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p> : session.isError ? <p role="alert">{t('social.error')}</p>
      : !session.data ? <p>{t('room_track.sign_in')} <Link to="/login?returnTo=%2Fsocial" onClick={onClose}>{t('common.action.log_in')}</Link></p>
        : <ProfileGate key={session.data.user.id} viewerId={session.data.user.id} track={track} onClose={onClose} />}
    <div className={styles.actions}><button className={styles.secondary} type="button" ref={close} onClick={onClose}>{t('common.action.close')}</button></div>
  </ModalDialog>;
}
