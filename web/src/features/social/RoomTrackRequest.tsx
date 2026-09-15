import type { RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useRoomCommunity } from './useRoomCommunity';
import styles from './SocialPage.module.css';

/** A request receipt alone is not proof that the host still has a pending recommendation. */
const RoomTrackRequest = ({ viewerId, room, mediaTrackId, disabled, submit }: {
  viewerId: string; room: RoomSnapshot; mediaTrackId: string; disabled: boolean;
  submit: (room: RoomSnapshot, refresh: () => Promise<unknown>) => void;
}) => {
  const { t } = useLocalization();
  const community = useRoomCommunity(viewerId, room, room.status === 'open');
  const data = !community.isError && community.data?.community.roomId === room.roomId
    && community.data.community.epoch === room.epoch ? community.data.community : undefined;
  const own = room.members.find(member => member.memberId === room.self.memberId);
  const requests = data?.requests.filter(request => request.requestedBy.socialId === own?.socialId) ?? [];
  const waiting = requests.some(request => request.mediaTrackId === mediaTrackId);
  return <>
    <p>{t('room_track.request_hint')}</p>
    {room.status !== 'open' && <p role="status">{t(room.status === 'ended' ? 'room.ended' : 'room.suspended')}</p>}
    {community.isPending && room.status === 'open' && <p role="status">{t('social.loading')}</p>}
    {community.isError && <p role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => community.refetch()}>{t('social.refresh')}</button></p>}
    {waiting && <p role="status">{t('room_track.waiting')}</p>}
    {requests.length >= 5 && <p>{t('room.request_limit')}</p>}
    {data && data.requests.length >= 20 && <p>{t('room.request_room_limit')}</p>}
    <button className={styles.button} disabled={disabled || room.status !== 'open' || !own || !data || waiting || requests.length >= 5 || data.requests.length >= 20}
      onClick={() => submit(room, () => community.refetch())}>{t('room.request_song')}</button>
  </>;
};

export default RoomTrackRequest;
