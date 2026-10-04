import { lazy, Suspense, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getOutgoingRoomInvitations, type RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import { CopyInvitationLink } from './CopyInvitationLink';
import { roomSession, useRoomSession } from './roomSession';
import { useInvitationNow } from './useInvitationNow';
import styles from './SocialPage.module.css';

const ConfirmActionDialog = lazy(() => import('./ConfirmActionDialog').then(module => ({ default: module.ConfirmActionDialog })));

/**
 * The host's invitation list, loaded only for the host so the room panel's initial JavaScript stays in budget.
 * A pending invitation can be copied as a link or explicitly replaced: replacement is the same server-checked
 * invite command, which issues a new invitation and makes the earlier link unusable (for example after it leaked).
 */
export const RoomInviteFriends = ({ room, viewerId }: { room: RoomSnapshot; viewerId: string }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const [replacing, setReplacing] = useState<{ socialId: string; alias: string } | null>(null);
  const friends = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', 'friends'],
    queryFn: async ({ pageParam, signal }) => (await import('../../api/social')).getSocialPage(viewerId, 'friends', pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const outgoing = useQuery({ queryKey: ['social', viewerId, 'room-outgoing-invitations', room.roomId],
    queryFn: ({ signal }) => getOutgoingRoomInvitations(viewerId, room.roomId, signal),
    enabled: room.self.isController && room.status === 'open', refetchInterval: 15_000, retry: false });
  const now = useInvitationNow();
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  const participants = new Set(room.members.map(value => value.socialId));
  const disabled = !(state.connected || state.realtimeBusy) || !room.self.isController || state.busy || Boolean(state.uncertain) || room.status !== 'open';
  const invite = (targetSocialId: string) => roomSession.run({ action: 'invite', ...member, targetSocialId });
  const pending = (socialId: string) => !participants.has(socialId)
    && Boolean(outgoing.data?.invitations.some(value => value.recipientSocialId === socialId && value.expiresAtMs > now));
  // An invitation accepted, expired or revoked while its dialog is open closes the dialog, so confirming can
  // never send an invitation the host did not mean to replace.
  const replaceable = replacing !== null && pending(replacing.socialId);
  useEffect(() => { if (replacing && !replaceable) setReplacing(null); }, [replacing, replaceable]);
  return <>
    <h3 style={{ marginTop: '1rem' }}>{t('room.invite_friends')}</h3>
    {outgoing.isError && <p className={styles.error} role="status">{t('social.error')} <button className={styles.secondary} onClick={() => outgoing.refetch()}>{t('social.refresh')}</button></p>}
    <ul className={styles.list}>{friends.data?.pages.flatMap(page => page.items).filter(friend => !participants.has(friend.socialId)).map(friend => {
      const invitation = room.self.isController && !outgoing.isError
        ? outgoing.data?.invitations.find(value => value.recipientSocialId === friend.socialId && value.expiresAtMs > now) : undefined;
      const alias = friend.profile?.alias ?? '';
      return <li className={`${styles.row} ${styles.invitationRow}`} key={friend.socialId}><div className={styles.rowContent}><strong>{alias}</strong>{invitation && <span>{t('room.invitation_pending')}</span>}</div>
        {invitation ? <>
          <CopyInvitationLink key={invitation.invitationId} viewerId={viewerId} invitationId={invitation.invitationId} alias={alias} disabled={disabled} />
          <button className={styles.secondary} disabled={disabled} onClick={() => setReplacing({ socialId: friend.socialId, alias })}>{t('room.invitation_replace')}</button>
        </> : <button className={styles.secondary} disabled={disabled || outgoing.isPending || outgoing.isError} onClick={() => invite(friend.socialId)}>{t('room.invite')}</button>}
      </li>;
    })}</ul>{friends.hasNextPage && <button className={styles.secondary} disabled={friends.isFetchingNextPage} onClick={() => friends.fetchNextPage()}>{t('common.action.load_more')}</button>}
    {replacing && replaceable && <Suspense fallback={null}><ConfirmActionDialog title={t('room.invitation_replace_confirm_title', { alias: replacing.alias })}
      description={t('room.invitation_replace_confirm_copy', { alias: replacing.alias })} confirmLabel={t('room.invitation_replace')} confirmDisabled={disabled}
      onCancel={() => setReplacing(null)} onConfirm={() => { const target = replacing.socialId; setReplacing(null); void invite(target); }} /></Suspense>}
  </>;
};
