import { Link } from 'react-router';
import { UsersRound } from 'lucide-react';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useRoomSession } from './roomSession';
import styles from '../../app/AppShell.module.css';

/** Returns to authoritative room controls without resuming playback or taking over a device. */
export const GlobalActiveRoom = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const state = useRoomSession();
  if (state.viewerId !== viewerId) return null;
  const room = state.room?.status !== 'ended' ? state.room : null;
  if (!room && !state.uncertain) return null;
  const status = t(state.uncertain ? 'room.entry_attention'
    : !state.connected ? 'room.entry_reconnecting'
      : room?.status === 'suspended' ? 'room.entry_suspended'
        : !room?.self.isController ? 'room.entry_observing'
          : state.locallyPaused ? 'room.entry_local_pause'
            : room.timeline?.state === 'playing' ? 'room.entry_playing'
              : room.timeline?.state === 'preparing' ? 'room.entry_preparing' : 'room.entry_paused');
  const title = room?.queue.find(entry => entry.entryId === room.timeline?.entryId)?.title;
  return <Link className={styles.account} to="/social" aria-label={t('room.entry_open', { status })}
    title={title ? `${status} · ${title}` : status}>
    <UsersRound aria-hidden="true" focusable="false" size={20} />
    <span>{status}</span>
  </Link>;
};
