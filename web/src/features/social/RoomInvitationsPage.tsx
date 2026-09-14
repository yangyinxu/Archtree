import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialProfile } from '../../api/social';
import { getRoomInvitation, type RoomInvitation } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useInvitationNow, useRoomInvitationConnection, useRoomInvitations } from './roomInvitationQueries';
import { roomSession, useRoomSession } from './roomSession';
import styles from './SocialPage.module.css';

const validInvitationId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id) && !/\s/.test(id);

/** Only an explicit acceptance on this page may navigate after confirmed membership. */
const InvitationActions = ({ viewerId, invitations, unavailable = false, showEmpty = true }: {
  viewerId: string; invitations: RoomInvitation[]; unavailable?: boolean; showEmpty?: boolean;
}) => {
  const { t, locale } = useLocalization();
  const navigate = useNavigate();
  const connection = useRoomInvitationConnection(viewerId);
  const state = useRoomSession();
  const [joining, setJoining] = useState(false);
  const mine = state.viewerId === viewerId;
  const blocked = !mine || !connection.ready || state.busy || Boolean(state.uncertain);
  const currentRoom = mine && state.room;

  useEffect(() => {
    if (!joining || !mine || state.busy || state.uncertain) return;
    if (state.room && !state.error) navigate('/social', { replace: true });
    setJoining(false);
  }, [joining, mine, state.busy, state.uncertain, state.room, state.error, navigate]);

  const respond = (invitation: RoomInvitation, action: 'acceptInvitation' | 'declineInvitation') => {
    const current = roomSession.getSnapshot();
    if (current.viewerId !== viewerId || current.busy || current.uncertain || invitation.expiresAtMs <= Date.now()) return;
    if (action === 'acceptInvitation' && (current.room || !current.connected || !connection.roomsEnabled)) return;
    const pending = roomSession.run({ action, invitationId: invitation.invitationId, generation: invitation.generation });
    // A stale connection may reject the action before it begins. Such a read cannot
    // become a navigation trigger when an unrelated existing membership arrives.
    if (action === 'acceptInvitation' && roomSession.getSnapshot().busy) setJoining(true);
    void pending;
  };

  return <>
    {connection.error && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => connection.retry()}>{t('social.refresh')}</button></p>}
    {mine && state.error && <div className={state.uncertain ? styles.error : styles.status} role="status">{t(state.error)}</div>}
    {mine && state.uncertain && <div className={styles.status} role="status">
      {!state.error && t('social.unknown')}
      <div className={styles.actions}>
        <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.checkOutcome()}>{t('social.check_outcome')}</button>
        <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.retry()}>{t('social.retry_same')}</button>
      </div>
    </div>}
    {currentRoom && <p className={styles.status}>{t('room.invitation_existing_room')} <Link to="/social">{t('social.nav')}</Link></p>}
    {connection.ready && !connection.roomsEnabled && <p className={styles.status}>{t('room.invitations_disabled')}</p>}
    {unavailable ? <p className={styles.empty}>{t('room.invitation_unavailable')}</p>
      : !invitations.length ? showEmpty && <p className={styles.empty}>{t('room.invitations_empty')}</p>
        : <ul className={styles.list}>{invitations.map(invitation => <li className={styles.row} key={invitation.invitationId}>
          <span className={styles.avatar} aria-hidden="true">{[...invitation.inviter.alias][0]?.toLocaleUpperCase()}</span>
          <div className={styles.rowContent}>
            <strong>{t('room.incoming_invite', { alias: invitation.inviter.alias })}</strong>
            <span>@{invitation.inviter.handle}</span>
            <span><time dateTime={new Date(invitation.expiresAtMs).toISOString()}>{t('room.invitation_expires', {
              time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(invitation.expiresAtMs)
            })}</time></span>
          </div>
          <div className={styles.rowActions}>
            <button className={styles.button} disabled={blocked || !connection.roomsEnabled || !state.connected || Boolean(currentRoom)} onClick={() => respond(invitation, 'acceptInvitation')}>{t('room.join')}</button>
            <button className={styles.secondary} disabled={blocked} onClick={() => respond(invitation, 'declineInvitation')}>{t('social.decline')}</button>
          </div>
        </li>)}</ul>}
  </>;
};

const InvitationList = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const result = useRoomInvitations(viewerId);
  return <>
    {result.isPending && <p role="status">{t('social.loading')}</p>}
    {result.isError && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => result.refetch()}>{t('social.refresh')}</button></p>}
    <InvitationActions viewerId={viewerId} invitations={result.isError ? [] : result.data?.invitations ?? []} showEmpty={Boolean(result.data) && !result.isError} />
  </>;
};

const InvitationDetail = ({ viewerId, invitationId }: { viewerId: string; invitationId: string }) => {
  const { t } = useLocalization();
  const result = useQuery({ queryKey: ['social', viewerId, 'room-invitation', invitationId],
    queryFn: ({ signal }) => getRoomInvitation(viewerId, invitationId, signal),
    refetchInterval: 15_000, refetchOnWindowFocus: 'always', retry: false });
  const now = useInvitationNow(result.data?.invitation?.expiresAtMs);
  const invitation = result.data?.invitation;
  const available = !result.isError && invitation && invitation.expiresAtMs > now;
  return <>
    {result.isPending && <p role="status">{t('social.loading')}</p>}
    {result.isError && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => result.refetch()}>{t('social.refresh')}</button></p>}
    <InvitationActions viewerId={viewerId} invitations={available ? [invitation] : []} unavailable={Boolean(result.data && !available && !result.isError)} showEmpty={false} />
  </>;
};

const InvitationAccount = ({ viewerId, invitationId }: { viewerId: string; invitationId?: string }) => {
  const { t } = useLocalization();
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'],
    queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  if (profile.isPending) return <p role="status">{t('social.loading')}</p>;
  if (profile.isError && !profile.data) return <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => profile.refetch()}>{t('social.refresh')}</button></p>;
  if (!profile.data?.profile?.active) return <p className={styles.empty}>{t(invitationId ? 'room.invitation_unavailable' : 'room.invitation_profile_needed')}</p>;
  return invitationId ? <InvitationDetail viewerId={viewerId} invitationId={invitationId} /> : <InvitationList viewerId={viewerId} />;
};

/** Recipient-only invitations remain private through sign-out, reconciliation and account changes. */
export const RoomInvitationsPage = () => {
  const { t } = useLocalization();
  const { invitationId } = useParams();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const valid = invitationId === undefined || validInvitationId(invitationId);
  const destination = valid && invitationId ? `/social/invitations/${invitationId}` : '/social/invitations';
  return <div className={styles.page}>
    <div className={styles.hero}><div><p className={styles.eyebrow}>Finitude · {t('social.nav')}</p><h1>{t('room.invitations')}</h1></div><Link className={styles.secondary} to="/social">{t('social.nav')}</Link></div>
    <section className={styles.panel}>
      {session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p>
        : session.isError ? <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => session.refetch()}>{t('social.refresh')}</button></p>
          : !valid ? <p className={styles.empty}>{t('room.invitation_unavailable')}</p>
            : !session.data ? <><p>{t('room.invitation_sign_in')}</p><div className={styles.actions}><Link className={styles.button} to={`/login?returnTo=${encodeURIComponent(destination)}`}>{t('common.action.log_in')}</Link></div></>
              : <InvitationAccount key={`${session.data.user.id}:${invitationId ?? ''}`} viewerId={session.data.user.id} invitationId={invitationId} />}
    </section>
  </div>;
};
