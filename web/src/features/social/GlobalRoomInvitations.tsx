import { lazy, Suspense, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bell } from 'lucide-react';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialProfile } from '../../api/social';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession } from './roomSession';
import { useRoomInvitationConnection, useRoomInvitations } from './roomInvitationQueries';
import styles from '../../app/AppShell.module.css';

const GlobalListeningPublisher = lazy(() => import('./GlobalListeningPublisher').then(module => ({ default: module.GlobalListeningPublisher })));

const PendingInvitations = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  useRoomInvitationConnection(viewerId);
  const invitations = useRoomInvitations(viewerId);
  const pending = Boolean(invitations.data?.invitations.length);
  return <Link className={`${styles.account} ${styles.invitationEntry}`} to="/social/invitations"
    aria-label={t(pending ? 'room.invitations_pending' : 'room.invitations')}
    title={t('room.invitations')} data-has-pending={pending ? 'true' : undefined}>
    <Bell aria-hidden="true" focusable="false" size={20} />
    {pending && <span className={styles.invitationDot} aria-hidden="true" />}
    <span className="visually-hidden" role="status">{pending ? t('room.invitations_pending') : ''}</span>
  </Link>;
};

const ViewerInvitations = ({ viewerId }: { viewerId: string }) => {
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'],
    queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  useEffect(() => {
    if (profile.data && !profile.data.profile?.active) roomSession.stop();
  }, [profile.data]);
  return profile.data?.profile?.active && !profile.isError ? <><PendingInvitations viewerId={viewerId} /><Suspense fallback={null}><GlobalListeningPublisher viewerId={viewerId} /></Suspense></> : null;
};

/** Lives inside the session privacy barrier and never takes a playback action on receipt. */
export const GlobalRoomInvitations = () => {
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  return session.data && !session.isError && !resolving.data
    ? <ViewerInvitations key={session.data.user.id} viewerId={session.data.user.id} /> : null;
};
