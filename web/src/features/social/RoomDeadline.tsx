import { useEffect, useState } from 'react';
import { ROOM_LIMITS } from '../../../../src/contracts/roomV1';
import type { RoomSnapshot } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useRoomSession } from './roomSession';
import styles from './SocialPage.module.css';

/** Whole seconds round up so a countdown reads 0:00 only once its deadline has actually passed. */
const formatRemaining = (milliseconds: number) => {
  const total = Math.ceil(milliseconds / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** The server clock reading a snapshot carries, and this device's monotonic time when the session accepted it. */
interface SnapshotClock { serverTimeMs: number; receivedAtMs: number }

/**
 * Remaining milliseconds until an absolute server deadline.
 *
 * Elapsed time is measured on this device's monotonic clock from the moment the room session accepted
 * the snapshot, not from when this component mounted: snapshots arrive only when the room changes, so
 * returning to the page, or loading this chunk late, must not restart a countdown from an old
 * `serverTimeMs`. A skewed or adjusted wall clock cannot shorten or extend the displayed time, and
 * every newer snapshot re-bases the measurement, which also corrects a clock that paused during sleep.
 */
const useServerCountdown = (deadlineMs: number, clock: SnapshotClock) => {
  const [, setTick] = useState(0);
  const remaining = Math.max(0, deadlineMs - clock.serverTimeMs - (performance.now() - clock.receivedAtMs));
  useEffect(() => {
    if (remaining <= 0) return;
    // Wake when the displayed whole second changes instead of polling.
    const timer = setTimeout(() => setTick(value => value + 1), remaining % 1000 || 1000);
    return () => clearTimeout(timer);
  });
  return remaining;
};

/** Reaching zero only stops the display; the server sweep alone suspends, closes or expires. */
const Countdown = ({ message, deadlineMs, clock, inline }: {
  message: MessageKey; deadlineMs: number; clock: SnapshotClock; inline?: boolean;
}) => {
  const { t } = useLocalization();
  const text = t(message, { remaining: formatRemaining(useServerCountdown(deadlineMs, clock)) });
  // The timer role's implicit aria-live="off" keeps screen readers from announcing every second.
  return inline ? <span role="timer">{text}</span> : <p className={styles.status} role="timer">{text}</p>;
};

/**
 * Host absence: the remaining grace before suspension, then the remaining time before the room ends.
 * The snapshot carries only the grace deadline (absence start + grace); the closing deadline follows
 * from the same absence start, so the strict room-v1 snapshot shape stays unchanged.
 */
const HostAbsence = ({ room, clock, connected }: { room: RoomSnapshot; clock: SnapshotClock; connected: boolean }) => {
  const { t } = useLocalization();
  const self = room.self.memberId === room.hostMemberId;
  // A host's own connected controller clears a just-recorded absence (after Use this device) with its next
  // heartbeat. Its heartbeats ride on acknowledged pings, and the session drops a socket whose pongs stop
  // within 15 s, so an absence the server sees for this controller soon shows here as disconnected too.
  const deadline = self && room.self.isController && connected ? null : room.hostAbsenceDeadlineMs;
  if (room.status === 'ended') return <p className={styles.status}>{t('room.ended')}</p>;
  const suspended = room.status === 'suspended';
  if (deadline === null) return suspended ? <p className={styles.status}>{t(self ? 'room.suspended_self' : 'room.suspended')}</p> : null;
  return <Countdown clock={clock}
    message={suspended ? self ? 'room.host_closing_self' : 'room.host_closing' : self ? 'room.host_absence_self' : 'room.host_absence'}
    deadlineMs={suspended ? deadline - ROOM_LIMITS.hostGraceMs + ROOM_LIMITS.hostCloseMs : deadline} />;
};

/** Host and recipient see the same server expiry; Accept stays a separate explicit action. */
const TransferExpiry = ({ room, clock }: { room: RoomSnapshot; clock: SnapshotClock }) => {
  const { t } = useLocalization();
  const offer = room.transferOffer;
  if (!offer) return null;
  return <>{t(offer.targetMemberId === room.self.memberId ? 'room.transfer_offered' : 'room.transfer_pending')}{' '}
    <Countdown inline message="room.transfer_expires" deadlineMs={offer.expiresAtMs} clock={clock} /></>;
};

/**
 * Lazily loaded so live room deadlines add no code to the initial Together route. The snapshot and its
 * receipt time come from the same room-session state, so they always describe the same server reading.
 */
const RoomDeadline = ({ kind }: { kind: 'host' | 'transfer' }) => {
  const { room, roomReceivedAtMs, connected } = useRoomSession();
  if (!room) return null;
  const clock = { serverTimeMs: room.serverTimeMs, receivedAtMs: roomReceivedAtMs };
  return kind === 'host' ? <HostAbsence room={room} clock={clock} connected={connected} /> : <TransferExpiry room={room} clock={clock} />;
};

export default RoomDeadline;
