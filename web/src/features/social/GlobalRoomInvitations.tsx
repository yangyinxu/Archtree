import { lazy, Suspense, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bell } from 'lucide-react';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { socialRolloutGateEvent } from '../../api/client';
import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { getSocialProfile } from '../../api/social';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession } from './roomSession';
import { GlobalActiveRoom } from './GlobalActiveRoom';
import { useRoomInvitationConnection, useRoomInvitations } from './roomInvitationQueries';
import { useSocialAvailability } from './socialAvailability';
import styles from '../../app/AppShell.module.css';

const GlobalListeningPublisher = lazy(() => import('./GlobalListeningPublisher').then(module => ({ default: module.GlobalListeningPublisher })));

const PendingInvitations = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
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

/** The transport keeps following the account room capability even while its entry points are hidden. */
const RoomConnection = ({ viewerId }: { viewerId: string }) => { useRoomInvitationConnection(viewerId); return null; };

const ViewerInvitations = ({ viewerId }: { viewerId: string }) => {
  const { roomsEnabled } = useSocialAvailability();
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'],
    queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  useEffect(() => {
    if (profile.data && !profile.data.profile?.active) roomSession.stop();
  }, [profile.data]);
  return profile.data?.profile?.active && !profile.isError ? <><RoomConnection viewerId={viewerId} />
    {roomsEnabled && <><GlobalActiveRoom viewerId={viewerId} /><PendingInvitations viewerId={viewerId} /></>}
    <Suspense fallback={null}><GlobalListeningPublisher viewerId={viewerId} /></Suspense></> : null;
};

/**
 * Lives inside the session privacy barrier and never takes a playback action on receipt. The shell mounts it
 * only while social is enabled, so it also owns reacting to a rollout gate: any feature-gate response
 * refreshes the public and account room capabilities, which hides the entry points the server now rejects.
 */
export const GlobalRoomInvitations = () => {
  const client = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: listenerCapabilitiesQueryKey });
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'social' && query.queryKey[2] === 'room-capabilities' });
    };
    addEventListener(socialRolloutGateEvent, refresh);
    return () => removeEventListener(socialRolloutGateEvent, refresh);
  }, [client]);
  return session.data && !session.isError && !resolving.data
    ? <ViewerInvitations key={session.data.user.id} viewerId={session.data.user.id} /> : null;
};
