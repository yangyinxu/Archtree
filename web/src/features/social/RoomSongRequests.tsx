import { lazy, Suspense, useState } from 'react';
import { roomControlPreconditions, type RoomAction, type RoomMedia, type RoomSnapshot } from '../../api/rooms';
import { Icon } from '../../components/Icon';
import { useLocalization } from '../../localization/LocalizationProvider';
import { roomSession, useRoomSession } from './roomSession';
import { useRoomCommunity } from './useRoomCommunity';
import styles from './SocialPage.module.css';

const LightInteractions = lazy(() => import('./RoomLightInteractions').then(module => ({ default: module.RoomLightInteractions })));
const RoomMediaPicker = lazy(() => import('./RoomMediaPicker').then(module => ({ default: module.RoomMediaPicker })));

/** Recommendations and queue management never optimistically change the shared timeline. */
export const RoomSongRequests = ({ viewerId, room }: { viewerId: string; room: RoomSnapshot }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const identity = `${viewerId}:${room.roomId}:${room.epoch}:${room.self.memberId}`;
  const [draft, setDraft] = useState<{ identity: string; selected: RoomMedia[] }>({ identity, selected: [] });
  const selected = draft.identity === identity ? draft.selected : [];
  const belongsToRoom = (current: ReturnType<typeof roomSession.getSnapshot>) => current.viewerId === viewerId
    && current.room?.roomId === room.roomId && current.room.epoch === room.epoch
    && current.room.self.memberId === room.self.memberId;
  const mine = belongsToRoom(state);
  const community = useRoomCommunity(viewerId, room, mine);
  if (!mine) return null;
  const data = !community.isError && community.data?.community.epoch === room.epoch
    && community.data.community.roomId === room.roomId ? community.data.community : undefined;
  const profiles = new Map(room.members.map(member => [member.socialId, member]));
  const own = room.members.find(member => member.memberId === room.self.memberId);
  const requests = data?.requests.filter(request => profiles.has(request.requestedBy.socialId)) ?? [];
  const ownRequests = requests.filter(request => request.requestedBy.socialId === own?.socialId);
  const pendingMedia = new Set(ownRequests.map(request => request.mediaTrackId));
  const busy = state.busy || Boolean(state.uncertain);
  const hostController = room.self.memberId === room.hostMemberId && room.self.isController;
  const canEdit = state.connected && room.status === 'open' && hostController && Boolean(room.timeline) && !busy;
  const canSelect = state.connected && room.self.isController && room.self.canControl
    && (room.status === 'open' || hostController && room.status === 'suspended') && !busy;
  const canRequest = state.connected && room.status === 'open' && !busy && Boolean(data)
    && ownRequests.length < 5 && requests.length < 20;
  const selectedAvailable = selected.length === 1 && !pendingMedia.has(selected[0].mediaTrackId);
  const submit = (action: RoomAction) => {
    if (!belongsToRoom(roomSession.getSnapshot())) return;
    void roomSession.run(action);
  };
  const member = { roomId: room.roomId, memberId: room.self.memberId };
  const move = (index: number, direction: -1 | 1) => {
    if (!canEdit || !room.timeline) return;
    const entryIds = room.queue.map(entry => entry.entryId);
    const other = index + direction;
    if (other < 0 || other >= entryIds.length) return;
    [entryIds[index], entryIds[other]] = [entryIds[other], entryIds[index]];
    submit({ action: 'reorderQueue', ...roomControlPreconditions(room), entryIds });
  };
  return <>
    <Suspense fallback={null}><LightInteractions viewerId={viewerId} room={room} community={data} updatedAt={community.dataUpdatedAt} /></Suspense>
    <section aria-label={t('room.requests_title')}>
      <h3>{t('room.requests_title')}</h3><p className={styles.muted}>{t('room.requests_hint')}</p>
      {community.isPending && <p role="status">{t('social.loading')}</p>}
      {community.isError && <p className={styles.error} role="alert">{t('social.error')} <button className={styles.secondary} onClick={() => community.refetch()}>{t('social.refresh')}</button></p>}
      <Suspense fallback={<p role="status">{t('social.loading')}</p>}><RoomMediaPicker key={identity} viewerId={viewerId} scopeKey={identity} selected={selected}
        onSelectionChange={items => setDraft({ identity, selected: items })} disabled={!canRequest} disabledMediaIds={pendingMedia} /></Suspense>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={!canRequest || !selectedAvailable} onClick={() => {
        if (canRequest && selectedAvailable) submit({ action: 'requestSong', ...member, expectedEpoch: room.epoch, mediaTrackId: selected[0].mediaTrackId });
      }}>{t('room.request_song')}</button></div>
      {ownRequests.length >= 5 && <p className={styles.muted}>{t('room.request_limit')}</p>}
      {requests.length >= 20 && <p className={styles.muted}>{t('room.request_room_limit')}</p>}
      {data && !requests.length && <p className={styles.empty}>{t('room.requests_empty')}</p>}
      <ul className={styles.list} aria-label={t('room.requests_title')}>{requests.map(request => <li className={styles.row} key={request.requestId}>
        <div className={styles.rowContent}><strong>{request.title}</strong><span>{t('room.requested_by', { alias: profiles.get(request.requestedBy.socialId)!.alias })}</span></div>
        <div className={styles.rowActions}>
          {hostController && <button className={styles.button} disabled={!canEdit || room.queue.length >= 100} onClick={() => submit({ action: 'acceptSongRequest', ...roomControlPreconditions(room), requestId: request.requestId })}>{t('room.request_accept')}</button>}
          {(hostController || request.requestedBy.socialId === own?.socialId) && <button className={styles.secondary} disabled={busy} onClick={() => submit({ action: 'dismissSongRequest', ...member, requestId: request.requestId })}>{t(request.requestedBy.socialId === own?.socialId ? 'room.request_withdraw' : 'room.request_dismiss')}</button>}
        </div>
      </li>)}</ul>
      {room.queue.length >= 100 && <p className={styles.muted}>{t('room.queue_full')}</p>}
    </section>
    <section aria-label={t('room.queue')}>
      <h3>{t('room.queue')}</h3>
      {hostController && <p className={styles.muted}>{t('room.queue_current_hint')}</p>}
      <ol className={`${styles.list} ${styles.queue}`}>{room.queue.map((entry, index) => {
        const requestedBy = data?.queueCredits.find(credit => credit.entryId === entry.entryId)?.requestedBy;
        const requester = requestedBy && profiles.get(requestedBy.socialId);
        return <li className={styles.row} key={entry.entryId}>
          <span className={styles.muted}>{index + 1}</span><div className={styles.rowContent}><strong className={entry.entryId === room.timeline?.entryId ? styles.selected : undefined}>{entry.title}</strong>
            <span>{`${Math.floor(entry.durationMs / 60_000)}:${String(Math.floor(entry.durationMs / 1000) % 60).padStart(2, '0')}`}</span>
            {requester && <span>{t('room.requested_by', { alias: requester.alias })}</span>}</div>
          <div className={styles.rowActions}>
            <button className={styles.secondary} aria-label={`${t('room.shared_play')} ${entry.title}`} disabled={!canSelect} onClick={() => roomSession.control('select', entry.entryId)}><Icon name="play" /></button>
            {hostController && <>
              <button className={styles.secondary} aria-label={t('room.queue_move_up', { title: entry.title })} disabled={!canEdit || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button className={styles.secondary} aria-label={t('room.queue_move_down', { title: entry.title })} disabled={!canEdit || index === room.queue.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button className={styles.secondary} aria-label={t('room.queue_remove', { title: entry.title })} disabled={!canEdit || entry.entryId === room.timeline?.entryId || room.queue.length <= 1} onClick={() => submit({ action: 'removeQueueEntry', ...roomControlPreconditions(room), targetEntryId: entry.entryId })}>×</button>
            </>}
          </div>
        </li>;
      })}</ol>
    </section>
  </>;
};
