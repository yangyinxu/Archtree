import { useEffect } from 'react';
import { Link } from 'react-router';
import type { MusicShareItem } from '../../api/musicShares';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession, useRoomSession } from './roomSession';
import { useRoomInvitationConnection } from './roomInvitationQueries';
import styles from './SocialPage.module.css';

/** Room participation is a separate lazy responsibility from reading a private music inbox. */
export const MusicShareRoomStatus = ({ viewerId, onRoomChange }: { viewerId: string; onRoomChange: (active: boolean) => void }) => {
  const { t } = useLocalization();
  useRoomInvitationConnection(viewerId);
  const state = useRoomSession();
  const active = state.viewerId === viewerId && Boolean(state.room);
  useEffect(() => { onRoomChange(active); }, [active, onRoomChange]);
  return <>
    {active && <p className={styles.status}>{t('music_shares.room_playback')} <Link to="/social">{t('music_shares.open_together')}</Link></p>}
    {state.viewerId === viewerId && (state.error || state.uncertain) && <div className={styles.status} role="status">
      {t(state.error ?? 'social.unknown')}
      {state.uncertain && <div className={styles.actions}>
        <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.checkOutcome()}>{t('social.check_outcome')}</button>
        <button className={styles.secondary} disabled={state.busy} onClick={() => roomSession.retry()}>{t('social.retry_same')}</button>
      </div>}
    </div>}
  </>;
};

/** A share never creates or joins a room; only a current host controller may send this explicit invitation. */
export const MusicShareInvite = ({ viewerId, item }: { viewerId: string; item: MusicShareItem }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const room = state.viewerId === viewerId ? state.room : null;
  if (!room || room.status !== 'open' || !room.self.isController || room.hostMemberId !== room.self.memberId
    || room.members.some(member => member.socialId === item.peer.socialId)) return null;
  return <button className={styles.secondary} disabled={!state.connected || state.busy || Boolean(state.uncertain)} onClick={() => {
    const current = roomSession.getSnapshot(); const value = current.room;
    if (!value || current.viewerId !== viewerId || !current.connected || current.busy || current.uncertain
      || value.roomId !== room.roomId || value.epoch !== room.epoch || value.self.memberId !== room.self.memberId
      || value.status !== 'open' || !value.self.isController || value.hostMemberId !== value.self.memberId || item.expiresAtMs <= Date.now()) return;
    void roomSession.run({ action: 'invite', roomId: value.roomId, memberId: value.self.memberId, targetSocialId: item.peer.socialId });
  }}>{t('music_shares.invite_back')}</button>;
};
