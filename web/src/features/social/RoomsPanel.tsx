import { lazy, Suspense, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getOutgoingRoomInvitations, getRoomMedia, roomControlPreconditions, type RoomSnapshot } from '../../api/rooms';
import type { SocialProfile } from '../../api/social';
import { useLocalization } from '../../localization/LocalizationProvider';
import { usePlayer } from '../../player';
import { Icon } from '../../components/Icon';
import { roomSession, useRoomSession } from './roomSession';
import { useInvitationNow, useRoomInvitationConnection, useRoomInvitations } from './roomInvitationQueries';
import styles from './SocialPage.module.css';

const seconds = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const CopyInvitationLink = lazy(() => import('./CopyInvitationLink').then(module => ({ default: module.CopyInvitationLink })));
const RoomSongRequests = lazy(() => import('./RoomSongRequests').then(module => ({ default: module.RoomSongRequests })));

const ActiveRoom = ({ room, viewerId }: { room: RoomSnapshot; viewerId: string }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const player = usePlayer();
  const [seek, setSeek] = useState<number | null>(null);
  const seekExpected = useRef<ReturnType<typeof roomControlPreconditions> | null>(null);
  const captureSeek = () => { if (!seekExpected.current && room.timeline) seekExpected.current = roomControlPreconditions(room); };
  const commitSeek = () => {
    const expected = seekExpected.current; seekExpected.current = null;
    if (seek !== null && expected) void roomSession.run({ ...expected, action: 'seek', positionMs: Math.round(seek * 1000) });
    setSeek(null);
  };
  const friends = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', 'friends'],
    queryFn: async ({ pageParam, signal }) => (await import('../../api/social')).getSocialPage(viewerId, 'friends', pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const host = room.self.memberId === room.hostMemberId;
  const outgoing = useQuery({ queryKey: ['social', viewerId, 'room-outgoing-invitations', room.roomId],
    queryFn: ({ signal }) => getOutgoingRoomInvitations(viewerId, room.roomId, signal),
    enabled: host && room.self.isController && room.status === 'open', refetchInterval: 15_000, retry: false });
  const now = useInvitationNow();
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  const allowed = state.connected && room.self.isController && room.self.canControl
    && (room.status === 'open' || host && room.status === 'suspended') && !state.busy && !state.uncertain;
  const needsLocalResume = state.locallyPaused || Boolean(player.error);
  const playing = room.timeline?.state === 'playing';
  const resumeOnly = needsLocalResume && (playing || !room.self.canControl);
  const localAllowed = state.connected && room.self.isController && room.status === 'open' && !state.busy && !state.uncertain;
  const primaryLabel = resumeOnly ? 'room.resync' : playing ? 'room.shared_pause'
    : needsLocalResume ? 'room.resume_and_play' : 'room.shared_play';
  const current = room.queue.find(entry => entry.entryId === room.timeline?.entryId);
  const elapsed = player.currentItem?.id === current?.mediaTrackId ? player.currentTime : (room.timeline?.positionMs ?? 0) / 1000;
  const duration = (room.timeline?.durationMs ?? 0) / 1000;
  const participants = new Set(room.members.map(value => value.socialId));
  const offer = room.transferOffer;
  const transferTarget = offer?.targetMemberId === room.self.memberId;
  return <>
    <div className={styles.roomHeading}><h2>{t('room.title')}</h2><span className={styles.muted}>{state.connected ? t('room.connected') : t('room.connecting')}</span></div>
    {room.status !== 'open' && <p className={styles.status}>{t(room.status === 'ended' ? 'room.ended' : 'room.suspended')}</p>}
    {!room.self.isController && <div className={styles.status}>{t('room.observing')}<div className={styles.actions}><button className={styles.button} disabled={!state.connected || state.busy} onClick={() => roomSession.run({ action: 'takeControl', ...member })}>{t('room.take_control')}</button></div></div>}
    <div className={styles.nowPlaying}><div className={styles.artwork}><Icon name="brand" /></div><div><strong>{current?.title ?? t('room.title')}</strong><p className={styles.muted}>{room.timeline?.state === 'preparing' ? t('room.preparing') : state.locallyPaused ? t('room.locally_paused') : t('room.position', { elapsed: seconds(elapsed), duration: seconds(duration) })}</p></div></div>
    {!room.self.canControl && !playing && room.status === 'open' && <p className={styles.status}>{t('room.waiting_for_host')}</p>}
    <input className={styles.seek} aria-label={t('room.seek')} type="range" min={0} max={Math.max(duration, 1)} step={.1}
      value={seek ?? Math.min(elapsed, duration)} disabled={!allowed}
      onPointerDown={captureSeek} onKeyDown={captureSeek}
      onChange={event => { captureSeek(); setSeek(Number(event.target.value)); }}
      onPointerUp={commitSeek} onPointerCancel={() => { seekExpected.current = null; setSeek(null); }}
      onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) commitSeek(); }} />
    <div className={styles.actions}>
      <button className={styles.secondary} aria-label={t('player.action.previous')} disabled={!allowed} onClick={() => roomSession.control('previous')}><Icon name="previous" /></button>
      <button className={styles.button} disabled={resumeOnly ? !localAllowed : !allowed} onClick={() => resumeOnly ? roomSession.resync() : roomSession.control(playing ? 'pause' : 'play')}><Icon name={playing && !resumeOnly ? 'pause' : 'play'} />{t(primaryLabel)}</button>
      <button className={styles.secondary} aria-label={t('player.action.next')} disabled={!allowed} onClick={() => roomSession.control('next')}><Icon name="next" /></button>
      {room.self.isController && (!needsLocalResume
        ? <button className={styles.secondary} disabled={!state.connected} onClick={() => roomSession.pauseLocally()}>{t('room.local_pause')}</button>
        : playing && room.self.canControl && <button className={styles.secondary} disabled={!allowed} onClick={() => roomSession.control('pause')}>{t('room.shared_pause')}</button>)}
    </div>
    {player.error && <p className={styles.error}>{t('room.start_failed')}</p>}
    <div className={`${styles.actions} ${styles.roomSettings}`}>
      <label className={styles.field}>{t('room.permissions')}<select value={room.controlMode} disabled={!host || !allowed || room.status !== 'open'} onChange={event => roomSession.control('setControlMode', event.target.value)}>
        <option value="hostOnly">{t('room.host_only')}</option><option value="everyone">{t('room.everyone')}</option>
      </select></label>
      <button className={host ? styles.danger : styles.secondary} disabled={state.busy} onClick={() => {
        if (host && !window.confirm(t('room.end_confirm'))) return;
        void roomSession.run({ action: host ? 'end' : 'leave', ...member });
      }}>{t(host ? 'room.end' : 'room.leave')}</button>
    </div>
    {offer && <div className={styles.status}>{t('room.transfer_pending')}<div className={styles.actions}>
      {transferTarget && <button className={styles.button} disabled={!state.connected || state.busy || !room.self.isController} onClick={() => roomSession.run({ action: 'acceptTransfer', ...member, offerId: offer.offerId })}>{t('room.accept_transfer')}</button>}
      {host && <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.run({ action: 'cancelTransfer', ...member, offerId: offer.offerId })}>{t('room.cancel_transfer')}</button>}
    </div></div>}
    <div className={styles.grid} style={{ marginTop: '1.5rem' }}><section>
      <h3>{t('room.members')}</h3><ul className={styles.list}>{room.members.map(participant => <li className={styles.row} key={participant.memberId}>
        <span className={styles.avatar} aria-hidden="true">{[...participant.alias][0]}</span><div className={styles.rowContent}><strong>{participant.alias}</strong><span>{t(participant.role === 'host' ? 'room.host' : 'room.guest')} · {t(participant.ready ? 'room.ready' : 'room.not_ready')}</span></div>
        {host && participant.memberId !== room.self.memberId && <div className={styles.rowActions}>
          <button className={styles.secondary} disabled={!state.connected || state.busy || !participant.connected || Boolean(offer)} onClick={() => roomSession.run({ action: 'offerTransfer', ...member,
            expectedControlGeneration: room.controlGeneration, targetMemberId: participant.memberId, targetControllerGeneration: participant.controllerGeneration })}>{t('room.transfer')}</button>
          <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.run({ action: 'kick', ...member, targetMemberId: participant.memberId })}>{t('room.kick')}</button>
        </div>}
      </li>)}</ul>
      {host && <><h3 style={{ marginTop: '1rem' }}>{t('room.invite_friends')}</h3>
        {outgoing.isError && <p className={styles.error} role="status">{t('social.error')} <button className={styles.secondary} onClick={() => outgoing.refetch()}>{t('social.refresh')}</button></p>}
        <ul className={styles.list}>{friends.data?.pages.flatMap(page => page.items).filter(friend => !participants.has(friend.socialId)).map(friend => {
          const invitation = room.self.isController && !outgoing.isError
            ? outgoing.data?.invitations.find(value => value.recipientSocialId === friend.socialId && value.expiresAtMs > now) : undefined;
          const disabled = !state.connected || !room.self.isController || state.busy || Boolean(state.uncertain) || room.status !== 'open';
          return <li className={`${styles.row} ${styles.invitationRow}`} key={friend.socialId}><div className={styles.rowContent}><strong>{friend.profile?.alias}</strong>{invitation && <span>{t('room.invitation_pending')}</span>}</div>
            {invitation ? <Suspense fallback={null}><CopyInvitationLink key={invitation.invitationId} viewerId={viewerId} invitationId={invitation.invitationId} alias={friend.profile?.alias ?? ''} disabled={disabled} /></Suspense>
              : <button className={styles.secondary} disabled={disabled || outgoing.isPending || outgoing.isError} onClick={() => roomSession.run({ action: 'invite', ...member, targetSocialId: friend.socialId })}>{t('room.invite')}</button>}
          </li>;
        })}</ul>{friends.hasNextPage && <button className={styles.secondary} disabled={friends.isFetchingNextPage} onClick={() => friends.fetchNextPage()}>{t('common.action.load_more')}</button>}</>}
    </section><div className={styles.stack}><Suspense fallback={<p role="status">{t('social.loading')}</p>}><RoomSongRequests key={`${viewerId}:${room.roomId}:${room.epoch}:${room.self.memberId}`} viewerId={viewerId} room={room} /></Suspense></div></div>
  </>;
};

/** The formal room surface creates and joins only server-authorized rooms. */
export const RoomsPanel = ({ viewerId, profile }: { viewerId: string; profile: SocialProfile }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const [selected, setSelected] = useState<string[]>([]);
  useRoomInvitationConnection(viewerId);
  const media = useQuery({ queryKey: ['social', viewerId, 'room-media'], queryFn: ({ signal }) => getRoomMedia(viewerId, signal), retry: false });
  const invitations = useRoomInvitations(viewerId);
  const room = state.viewerId === viewerId ? state.room : null;
  const busy = state.busy || Boolean(state.uncertain);
  return <section className={`${styles.panel} ${styles.roomPanel}`} aria-label={t('room.title')}>
    {(state.error || state.uncertain) && <div className={styles.error} role="status">{t(state.error ?? 'social.unknown')}
      {!state.connected && <div className={styles.actions}><button className={styles.secondary} onClick={() => roomSession.reconnect()}>{t('room.reconnect')}</button></div>}
      {state.uncertain && <div className={styles.actions}><button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.checkOutcome()}>{t('social.check_outcome')}</button><button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.retry()}>{t('social.retry_same')}</button></div>}
    </div>}
    {room ? <ActiveRoom room={room} viewerId={viewerId} /> : <>
      <div className={styles.roomHeading}><h2>{t('room.title')}</h2><span className={styles.muted}>{state.connected ? t('room.connected') : t('room.connecting')}</span></div>
      <p className={styles.description}>{t('room.empty')}</p><p className={styles.muted}>{t('social.signed_in', { alias: profile.alias })}</p>
      {invitations.data?.invitations.length ? <div style={{ marginTop: '1rem' }}><h3>{t('room.invitations')}</h3><ul className={styles.list}>{invitations.data.invitations.map(invitation => <li className={styles.row} key={invitation.invitationId}>
        <div className={styles.rowContent}><strong>{t('room.incoming_invite', { alias: invitation.inviter.alias })}</strong></div>
        <button className={styles.button} disabled={!state.connected || busy} onClick={() => roomSession.run({ action: 'acceptInvitation', invitationId: invitation.invitationId, generation: invitation.generation })}>{t('room.join')}</button>
        <button className={styles.secondary} disabled={busy} onClick={() => roomSession.run({ action: 'declineInvitation', invitationId: invitation.invitationId, generation: invitation.generation })}>{t('social.decline')}</button>
      </li>)}</ul></div> : null}
      <h3 style={{ marginTop: '1.4rem' }}>{t('room.choose_music')}</h3>
      {media.isPending ? <p role="status">{t('social.loading')}</p> : media.isError ? <p className={styles.error}>{t('social.error')}</p>
        : !media.data.items.length ? <p className={styles.empty}>{t('room.no_media')}</p>
          : <ul className={`${styles.list} ${styles.queue}`}>{media.data.items.map(item => <li key={item.mediaTrackId}>
            <label className={styles.check}><input type="checkbox" checked={selected.includes(item.mediaTrackId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.mediaTrackId] : previous.filter(id => id !== item.mediaTrackId))} /><span>{item.title} <span className={styles.muted}>· {seconds(item.durationMs / 1000)}</span></span></label>
          </li>)}</ul>}
      <div className={styles.actions}><button className={styles.button} disabled={!state.connected || busy || !selected.length} onClick={() => roomSession.run({ action: 'create', mediaTrackIds: selected })}><Icon name="play" />{t('room.create')}</button></div>
    </>}
  </section>;
};
