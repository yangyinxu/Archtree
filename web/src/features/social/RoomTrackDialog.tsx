import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import type { getSocialProfile } from '../../api/social';
import { getCurrentRoom, getOutgoingRoomInvitations, type RoomSnapshot } from '../../api/rooms';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { roomSession, useRoomSession } from './roomSession';
import { useRoomInvitationConnection } from './roomInvitationQueries';
import type { RoomTrackButtonProps } from './RoomTrackButton';
import styles from './SocialPage.module.css';

const RoomTrackRequest = lazy(() => import('./RoomTrackRequest'));

const sameMembership = (left: RoomSnapshot | null, right: RoomSnapshot | null) => Boolean(left && right
  && left.roomId === right.roomId && left.epoch === right.epoch && left.self.memberId === right.self.memberId);

/** Explicit creation and invitation are separate recoverable commands; no route or snapshot resumes a send. */
const RoomTrackComposer = ({ viewerId, track, onClose }: { viewerId: string; track: RoomTrackButtonProps; onClose: () => void }) => {
  const { t } = useLocalization();
  const client = useQueryClient();
  const connection = useRoomInvitationConnection(viewerId);
  const state = useRoomSession();
  const room = state.viewerId === viewerId ? state.room : null;
  const [selected, setSelected] = useState(''), [pending, setPending] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const lifecycle = useRef(0), working = useRef(false);
  useEffect(() => { lifecycle.current += 1; return () => { lifecycle.current += 1; }; }, []);
  const media = useQuery({ queryKey: ['social', viewerId, 'room-media-track', track.mediaTrackId],
    queryFn: async ({ signal }) => {
      const api = await import('../../api/roomMedia'); signal.throwIfAborted();
      return api.getRoomMediaTrack(viewerId, track.mediaTrackId, signal);
    },
    enabled: connection.ready && connection.roomsEnabled, retry: false });
  const friends = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', 'friends'],
    queryFn: async ({ pageParam, signal }) => {
      const api = await import('../../api/social'); signal.throwIfAborted();
      return api.getSocialPage(viewerId, 'friends', pageParam, signal);
    },
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: connection.ready && connection.roomsEnabled && !room, refetchOnWindowFocus: 'always', retry: false });
  const rows = friends.isError ? [] : [...new Map(friends.data?.pages.flatMap(page => page.items)
    .filter(row => row.profile).map(row => [row.socialId, row]) ?? []).values()];
  const selectedFriend = rows.find(row => row.socialId === selected);
  const available = !media.isError && media.data?.item?.mediaTrackId === track.mediaTrackId;
  const blocked = pending || !connection.ready || connection.error || !connection.roomsEnabled || state.viewerId !== viewerId
    || !state.connected || state.busy || Boolean(state.uncertain) || !available;
  const submit = async (expected: RoomSnapshot | null, refresh?: () => Promise<unknown>) => {
    if (working.current || blocked || !expected && !selectedFriend) return;
    const guard = captureAccountOperation(viewerId), mounted = lifecycle.current;
    // Cache updates precede React's subscription render, so async continuations check the privacy barrier directly.
    const valid = () => lifecycle.current === mounted && isAccountOperationCurrent(guard, viewerId)
      && !client.getQueryData(browserSessionResolvingQuery().queryKey)
      && client.getQueryData(browserSessionQuery().queryKey)?.user.id === viewerId
      && client.getQueryState(['social', viewerId, 'profile'])?.status === 'success'
      && client.getQueryData<Awaited<ReturnType<typeof getSocialProfile>>>(['social', viewerId, 'profile'])?.profile?.active === true;
    const actionable = () => {
      const current = roomSession.getSnapshot();
      return valid() && current.viewerId === viewerId && current.connected && !current.busy && !current.uncertain;
    };
    const changed = async () => { await roomSession.refresh(); if (valid()) setMessage('room_track.room_changed'); };
    working.current = true; setPending(true); setMessage(null);
    try {
      const actual = await getCurrentRoom(viewerId);
      if (!valid()) return;
      const current = roomSession.getSnapshot();
      if (expected ? !sameMembership(actual.room, expected) || !sameMembership(current.room, expected)
        : Boolean(actual.room || current.room)) { await changed(); return; }
      const mediaApi = await import('../../api/roomMedia');
      if (!valid()) return;
      const eligible = await mediaApi.getRoomMediaTrack(viewerId, track.mediaTrackId);
      if (!valid()) return;
      if (!eligible.item || eligible.item.mediaTrackId !== track.mediaTrackId) { setMessage('room_track.unsupported'); return; }
      if (!actionable()) return;
      const before = roomSession.getSnapshot().room;
      if (expected ? !sameMembership(before, expected) || before?.status !== 'open' : Boolean(before)) { await changed(); return; }
      if (expected) {
        await roomSession.run({ action: 'requestSong', roomId: expected.roomId, memberId: expected.self.memberId,
          expectedEpoch: expected.epoch, mediaTrackId: track.mediaTrackId });
        const outcome = roomSession.getSnapshot();
        if (actionable() && !outcome.error && sameMembership(outcome.room, expected)) await refresh?.();
        return;
      }
      await roomSession.run({ action: 'create', mediaTrackIds: [track.mediaTrackId] });
      if (!actionable() || roomSession.getSnapshot().error) return;
      const created = roomSession.getSnapshot().room;
      if (!created || created.status !== 'open' || !created.self.isController || created.hostMemberId !== created.self.memberId
        || created.timeline?.state !== 'paused' || created.queue.length !== 1 || created.queue[0].mediaTrackId !== track.mediaTrackId) return;
      const confirmed = await getCurrentRoom(viewerId);
      if (!actionable()) return;
      const latest = roomSession.getSnapshot().room;
      if (!sameMembership(confirmed.room, created) || !sameMembership(latest, created) || latest?.status !== 'open'
        || !latest.self.isController || latest.hostMemberId !== latest.self.memberId) { await changed(); return; }
      await roomSession.run({ action: 'invite', roomId: created.roomId, memberId: created.self.memberId, targetSocialId: selectedFriend!.socialId });
      if (!actionable() || roomSession.getSnapshot().error || !sameMembership(roomSession.getSnapshot().room, created)) return;
      const outgoing = await getOutgoingRoomInvitations(viewerId, created.roomId);
      if (valid() && sameMembership(roomSession.getSnapshot().room, created)
        && outgoing.invitations.some(invitation => invitation.recipientSocialId === selectedFriend!.socialId)) setMessage('room_track.invited');
    } catch { if (valid()) setMessage('social.error'); }
    finally { working.current = false; if (valid()) setPending(false); }
  };
  return <>
    {state.viewerId === viewerId && (state.error || state.uncertain) && <div className={styles.status} role="status">
      {t(state.error ?? 'social.unknown')}{state.uncertain && <div className={styles.actions}>
        <button className={styles.secondary} disabled={state.busy || pending} onClick={() => roomSession.checkOutcome()}>{t('social.check_outcome')}</button>
        <button className={styles.secondary} disabled={state.busy || pending} onClick={() => roomSession.retry()}>{t('social.retry_same')}</button>
      </div>}
    </div>}
    {message && <p role={message === 'social.error' ? 'alert' : 'status'}>{t(message)}</p>}
    {!connection.ready && !connection.error && <p role="status">{t('social.loading')}</p>}
    {connection.ready && !connection.roomsEnabled && <p>{t('room.invitations_disabled')}</p>}
    {connection.ready && connection.roomsEnabled && (!state.connected || state.viewerId !== viewerId) && <p role="status">{t('room.connecting')}</p>}
    {(connection.error || media.isError || !room && friends.isError) && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => {
      void connection.retry(); void media.refetch(); if (!room) void friends.refetch();
    }}>{t('social.refresh')}</button></p>}
    {connection.roomsEnabled && (media.isPending ? <p role="status">{t('social.loading')}</p>
      : !media.isError && !available && <><p>{t('room_track.unsupported')}</p><p className={styles.muted}>{t('room.media_eligibility')}</p></>)}
    {room ? <Suspense fallback={<p role="status">{t('social.loading')}</p>}><RoomTrackRequest viewerId={viewerId} room={room} mediaTrackId={track.mediaTrackId} disabled={blocked}
      submit={(expected, refresh) => { void submit(expected, refresh); }} /></Suspense> : <form className={styles.stack} onSubmit={event => { event.preventDefault(); void submit(null); }}>
      <p>{t('room_track.create_hint')}</p>
      {connection.roomsEnabled && friends.isPending && <p role="status">{t('social.loading')}</p>}
      {!friends.isPending && !friends.isError && !rows.length && <p>{t('room_track.no_friends')}</p>}
      <label className={styles.field}>{t('music_shares.choose_friend')}<select value={selected} onChange={event => setSelected(event.target.value)} disabled={blocked || !rows.length}>
        <option value="">{t('music_shares.choose_friend')}</option>
        {rows.map(row => <option key={row.socialId} value={row.socialId}>{row.profile!.alias} (@{row.profile!.handle})</option>)}
      </select></label>
      {friends.hasNextPage && <button type="button" className={styles.secondary} disabled={friends.isFetchingNextPage || pending} onClick={() => friends.fetchNextPage()}>{t('common.action.load_more')}</button>}
      <button className={styles.button} disabled={blocked || !selectedFriend}>{t('listening.confirm')}</button>
    </form>}
    <div className={styles.actions}><Link to="/social" onClick={onClose}>{t('music_shares.open_together')}</Link></div>
  </>;
};

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
      : <RoomTrackComposer viewerId={viewerId} track={track} onClose={onClose} />;
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
