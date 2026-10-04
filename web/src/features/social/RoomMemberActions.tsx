import { lazy, Suspense, useState } from 'react';
import type { RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession, useRoomSession } from './roomSession';
import styles from './SocialPage.module.css';

const ConfirmActionDialog = lazy(() => import('./ConfirmActionDialog').then(module => ({ default: module.ConfirmActionDialog })));

/**
 * Host-only actions for another member, loaded only for the host so the room panel's initial JavaScript stays in
 * budget. Removing a member stops their shared listening immediately, so it asks first; the dialog belongs to the
 * member's row and disappears with it if that member leaves meanwhile.
 */
export const RoomMemberActions = ({ room, participant }: { room: RoomSnapshot; participant: RoomSnapshot['members'][number] }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const [confirming, setConfirming] = useState(false);
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  return <div className={styles.rowActions}>
    <button className={styles.secondary} disabled={!state.connected || state.busy || !participant.connected || Boolean(room.transferOffer)} onClick={() => roomSession.run({ action: 'offerTransfer', ...member,
      expectedControlGeneration: room.controlGeneration, targetMemberId: participant.memberId, targetControllerGeneration: participant.controllerGeneration })}>{t('room.transfer')}</button>
    <button className={styles.secondary} disabled={state.busy} onClick={() => setConfirming(true)}>{t('room.kick')}</button>
    {confirming && <Suspense fallback={null}><ConfirmActionDialog title={t('room.kick_confirm_title', { alias: participant.alias })}
      description={t('room.kick_confirm_copy', { alias: participant.alias })} confirmLabel={t('room.kick')} confirmDisabled={state.busy}
      onCancel={() => setConfirming(false)} onConfirm={() => {
        setConfirming(false);
        void roomSession.run({ action: 'kick', ...member, targetMemberId: participant.memberId });
      }} /></Suspense>}
  </div>;
};
