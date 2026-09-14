import { useEffect, useRef, useState } from 'react';
import { ROOM_REACTIONS, type RoomReaction } from '../../../../src/contracts/roomV1';
import type { RoomCommunity, RoomCommunityEvent } from '../../api/roomCommunity';
import type { RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { roomSession, useRoomSession } from './roomSession';
import { useInvitationNow } from './useInvitationNow';
import styles from './SocialPage.module.css';

const emoji: Record<RoomReaction, string> = { heart: '❤️', clap: '👏', fire: '🔥', smile: '🙂', music: '🎵' };
const notice: Record<Exclude<RoomCommunityEvent['kind'], 'reaction'>, MessageKey> = {
  joined: 'room.activity_joined', trackChanged: 'room.activity_track_changed',
  hostChanged: 'room.activity_host_changed', modeChanged: 'room.activity_mode_changed'
};

/** Reactions are explicit member intents; confirmed activity never calls the player or echoes commands. */
export const RoomLightInteractions = ({ viewerId, room, community, updatedAt }: {
  viewerId: string; room: RoomSnapshot; community?: RoomCommunity; updatedAt: number;
}) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  const identity = `${viewerId}:${room.roomId}:${room.epoch}:${room.self.memberId}`;
  const mine = state.viewerId === viewerId && state.room?.roomId === room.roomId && state.room.epoch === room.epoch
    && state.room.self.memberId === room.self.memberId;
  const valid = mine && room.status !== 'ended' && community?.roomId === room.roomId && community.epoch === room.epoch;
  const events = valid ? community.events : [];
  const nextExpiry = events.reduce((next, event) => event.expiresAtMs > Date.now() ? Math.min(next, event.expiresAtMs) : next, Infinity);
  const now = useInvitationNow(Number.isFinite(nextExpiry) ? nextExpiry : undefined);
  const profiles = new Map(room.members.map(member => [member.socialId, member]));
  const profileKey = room.members.map(member => `${member.socialId}:${member.alias}`).join('|');
  const visible = events.filter(event => event.expiresAtMs > now && (!event.actor || profiles.has(event.actor.socialId))).slice(-20);
  const tracker = useRef({ identity, connected: state.connected, seeded: false, waitingAfter: -1, seen: new Map<string, number>() });
  const [announced, setAnnounced] = useState<{ identity: string; profiles: string; ids: string[] }>({ identity, profiles: profileKey, ids: [] });
  useEffect(() => {
    const previous = tracker.current;
    if (previous.identity !== identity) tracker.current = { identity, connected: state.connected, seeded: false, waitingAfter: -1, seen: new Map() };
    const current = tracker.current;
    if (current.connected !== state.connected) {
      current.connected = state.connected; current.seeded = false; current.waitingAfter = updatedAt;
      setAnnounced({ identity, profiles: profileKey, ids: [] });
    }
    for (const [id, expiry] of current.seen) if (expiry <= now) current.seen.delete(id);
    if (!valid) return;
    const fresh = visible.filter(event => !current.seen.has(event.eventId));
    for (const event of events) current.seen.set(event.eventId, event.expiresAtMs);
    // Cache displayed during reconnection is not a new live delivery. The first fresh response becomes its baseline.
    if (!state.connected || !current.seeded) {
      if (state.connected && (current.waitingAfter < 0 || updatedAt !== current.waitingAfter)) current.seeded = true;
      return;
    }
    if (fresh.length) setAnnounced({ identity, profiles: profileKey, ids: fresh.map(event => event.eventId) });
  }, [identity, state.connected, community, updatedAt, now, valid]);
  const describe = (event: RoomCommunityEvent) => event.actor
    ? event.kind === 'reaction' ? t('room.activity_reaction', { alias: profiles.get(event.actor.socialId)!.alias, emoji: emoji[event.reaction!] })
      : t(notice[event.kind], { alias: profiles.get(event.actor.socialId)!.alias })
    : t('room.activity_auto_next');
  const announcements = announced.identity === identity && announced.profiles === profileKey && state.connected
    ? visible.filter(event => announced.ids.includes(event.eventId)) : [];
  if (!mine) return null;
  const disabled = !state.connected || room.status !== 'open' || state.busy || Boolean(state.uncertain);
  return <section aria-label={t('room.activity_title')}>
    <h3>{t('room.activity_title')}</h3><p className={styles.muted}>{t('room.activity_hint')}</p>
    <div className={styles.actions}>{ROOM_REACTIONS.map(reaction => <button key={reaction} className={styles.secondary} type="button"
      aria-label={t(`room.react_${reaction}`)} disabled={disabled} onClick={() => {
        const current = roomSession.getSnapshot(); const active = current.room;
        if (current.viewerId !== viewerId || !active || active.roomId !== room.roomId || active.epoch !== room.epoch
          || active.self.memberId !== room.self.memberId || !current.connected || active.status !== 'open' || current.busy || current.uncertain) return;
        void roomSession.run({ action: 'react', roomId: room.roomId, memberId: room.self.memberId, expectedEpoch: room.epoch, reaction });
      }}><span aria-hidden="true">{emoji[reaction]}</span></button>)}</div>
    <ul className={styles.list} aria-label={t('room.activity_title')}>{visible.map(event => <li className={styles.row} key={event.eventId}>
      <span className={styles.muted}>{describe(event)}</span>
    </li>)}</ul>
    {valid && !visible.length && <p className={styles.empty}>{t('room.activity_empty')}</p>}
    <span className="visually-hidden" role="status" aria-label={t('room.activity_title')} aria-live="polite" aria-atomic="true">
      {announcements.length > 0 && announcements.length === announced.ids.length && <span key={announced.ids.join(':')}>{announcements.map(describe).join(' ')}</span>}
    </span>
  </section>;
};
