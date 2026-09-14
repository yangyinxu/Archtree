import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import type { FriendListeningStatus } from '../../api/listening';
import { getCurrentRoom } from '../../api/rooms';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession, useRoomSession } from './roomSession';
import { useRoomInvitationConnection } from './roomInvitationQueries';
import styles from './SocialPage.module.css';

/** Creating a paused room and inviting remain separate commands, each with the shared receipt recovery. */
export const InviteListeningFriend = ({ viewerId, item, expiresInMs }: { viewerId: string; item: FriendListeningStatus; expiresInMs: number }) => {
  const { t } = useLocalization();
  const connection = useRoomInvitationConnection(viewerId);
  const state = useRoomSession();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(false);
  const close = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLButtonElement>(null), alive = useRef(true), working = useRef(false);
  const deadline = useRef(performance.now() + expiresInMs); deadline.current = performance.now() + expiresInMs;
  useEffect(() => {
    // StrictMode replays setup after cleanup while preserving this ref.
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const room = state.viewerId === viewerId ? state.room : null;
  const host = room?.status === 'open' && room.self.isController && room.hostMemberId === room.self.memberId;
  const blocked = pending || !connection.ready || !connection.roomsEnabled || !state.connected || state.busy || Boolean(state.uncertain);
  const invite = async (create: boolean) => {
    if (working.current || blocked || performance.now() >= deadline.current) return;
    const guard = captureAccountOperation(viewerId);
    const valid = () => alive.current && isAccountOperationCurrent(guard, viewerId) && performance.now() < deadline.current;
    working.current = true; setPending(true); setError(false);
    try {
      const actual = await getCurrentRoom(viewerId);
      if (!valid()) return;
      if (create) {
        if (actual.room || roomSession.getSnapshot().room) { await roomSession.refresh(); return; }
        await roomSession.run({ action: 'create', mediaTrackIds: [item.track.id] });
        if (!valid()) return;
      } else if (!actual.room || actual.room.roomId !== room?.roomId || actual.room.epoch !== room.epoch
        || actual.room.self.memberId !== room.self.memberId) { await roomSession.refresh(); return; }
      const current = roomSession.getSnapshot(), value = current.room;
      if (!valid() || current.viewerId !== viewerId || current.busy || current.uncertain || create && current.error || !current.connected
        || !value || !create && (value.roomId !== actual.room?.roomId || value.epoch !== actual.room.epoch || value.self.memberId !== actual.room.self.memberId) || value.status !== 'open' || !value.self.isController || value.hostMemberId !== value.self.memberId) return;
      await roomSession.run({ action: 'invite', roomId: value.roomId, memberId: value.self.memberId, targetSocialId: item.peer.socialId });
      if (valid() && !roomSession.getSnapshot().uncertain && !roomSession.getSnapshot().error) setOpen(false);
    } catch { if (valid()) setError(true); }
    finally { working.current = false; if (alive.current && isAccountOperationCurrent(guard, viewerId)) setPending(false); }
  };
  const recovery = state.viewerId === viewerId && (state.uncertain || state.error) ? <div className={styles.status} role="status">
    {t(state.error ?? 'social.unknown')}{state.uncertain && <div className={styles.actions}>
      <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.checkOutcome()}>{t('social.check_outcome')}</button>
      <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.retry()}>{t('social.retry_same')}</button>
    </div>}
  </div> : null;
  if (room && !host) return <Link className={styles.secondary} to="/social">{t('music_shares.open_together')}</Link>;
  if (room?.members.some(member => member.socialId === item.peer.socialId)) return null;
  return <>
    <button className={styles.secondary} ref={trigger} disabled={blocked} onClick={() => { if (host) void invite(false); else setOpen(true); }}>{t(host ? 'listening.invite' : 'listening.create_invite')}</button>
    {!open && recovery}
    {error && !open && <p role="alert">{t('social.error')}</p>}
    {open && createPortal(<ModalDialog title={t('listening.confirm_title', { alias: item.peer.alias })} description={t('listening.confirm_copy', { alias: item.peer.alias, title: item.track.title })}
      initialFocusRef={close} returnFocusRef={trigger} onClose={() => setOpen(false)}>
      {recovery}{error && <p role="alert">{t('social.error')}</p>}
      {host && <p>{t('listening.created')}</p>}
      <div className={styles.actions}><button className={styles.button} disabled={blocked} onClick={() => invite(!host)}>{t(host ? 'listening.invite' : 'listening.confirm')}</button>
        <button className={styles.secondary} ref={close} onClick={() => setOpen(false)}>{t('common.action.close')}</button>
        <Link to="/social" onClick={() => setOpen(false)}>{t('music_shares.open_together')}</Link>
      </div>
    </ModalDialog>, document.body)}
  </>;
};
