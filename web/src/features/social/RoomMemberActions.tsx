import { lazy, Suspense, useState } from 'react';
import type { RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession, useRoomSession } from './roomSession';
import styles from './SocialPage.module.css';

const ConfirmActionDialog = lazy(() => import('./ConfirmActionDialog').then(module => ({ default: module.ConfirmActionDialog })));

/**
 * Host-only actions for another member, loaded only for the host so the room panel's initial JavaScript stays in
 * budget. Like Invite, both need the host's active playback device, so an observing host tab cannot send commands
 * the server refuses. Removing a member stops their shared listening immediately, so it asks first; the dialog
 * belongs to the member's row and disappears with it if that member leaves meanwhile.
 */
export const RoomMemberActions = ({ room, participant }: { room: RoomSnapshot; participant: RoomSnapshot['members'][number] }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const [confirming, setConfirming] = useState(false);
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  return <div className={styles.rowActions}>
    <button className={styles.secondary} disabled={!state.connected || state.busy || !room.self.isController || !participant.connected || Boolean(room.transferOffer)} onClick={() => roomSession.run({ action: 'offerTransfer', ...member,
      expectedControlGeneration: room.controlGeneration, targetMemberId: participant.memberId, targetControllerGeneration: participant.controllerGeneration })}>{t('room.transfer')}</button>
    <button className={styles.secondary} disabled={state.busy || !room.self.isController} onClick={() => setConfirming(true)}>{t('room.kick')}</button>
    {confirming && <Suspense fallback={null}><ConfirmActionDialog title={t('room.kick_confirm_title', { alias: participant.alias })}
      description={t('room.kick_confirm_copy', { alias: participant.alias })} confirmLabel={t('room.kick')} confirmDisabled={state.busy || !room.self.isController}
      onCancel={() => setConfirming(false)} onConfirm={() => {
        setConfirming(false);
        void roomSession.run({ action: 'kick', ...member, targetMemberId: participant.memberId });
      }} /></Suspense>}
  </div>;
};
