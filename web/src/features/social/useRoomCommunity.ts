import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { captureAccountOperation, isAccountOperationCurrent, subscribeToAccountEpoch } from '../../api/accountEpoch';
import { getRoomCommunity } from '../../api/roomCommunity';
import type { RoomSnapshot } from '../../api/rooms';

/** One membership-scoped read serves queue recommendations and ephemeral activity. Snapshot bursts get a bounded trailing refresh. */
export const useRoomCommunity = (viewerId: string, room: RoomSnapshot, enabled: boolean) => {
  const clock = useMemo(() => ({ guard: captureAccountOperation(viewerId), active: true, target: 0, attempted: 0,
    dataRevision: 0, fetching: false, lastRequestAt: -Infinity, timer: undefined as ReturnType<typeof setTimeout> | undefined }),
  [viewerId, room.roomId, room.epoch, room.self.memberId]);
  clock.target = room.revision;
  const result = useQuery({ queryKey: ['social', viewerId, 'room-community', room.roomId, room.epoch, room.self.memberId],
    queryFn: ({ signal }) => {
      if (!clock.active || !isAccountOperationCurrent(clock.guard, viewerId)) throw new DOMException('Account changed.', 'AbortError');
      clearTimeout(clock.timer); clock.timer = undefined;
      clock.attempted = clock.target; clock.lastRequestAt = Date.now();
      return getRoomCommunity(viewerId, room.roomId, signal);
    }, enabled, refetchInterval: 15_000, refetchOnWindowFocus: 'always', retry: false });
  clock.fetching = result.isFetching;
  clock.dataRevision = result.data?.community.epoch === room.epoch ? result.data.community.revision : 0;
  useEffect(() => {
    clock.active = true;
    const stop = () => { clock.active = false; clearTimeout(clock.timer); clock.timer = undefined; };
    const unsubscribe = subscribeToAccountEpoch(stop);
    return () => { stop(); unsubscribe(); };
  }, [clock]);
  useEffect(() => {
    const needed = () => enabled && clock.active && isAccountOperationCurrent(clock.guard, viewerId)
      && !clock.fetching && clock.target > clock.dataRevision && clock.target > clock.attempted;
    if (!needed()) {
      if (!enabled || clock.target <= clock.dataRevision) { clearTimeout(clock.timer); clock.timer = undefined; }
      return;
    }
    if (clock.timer !== undefined) return;
    const refresh = () => {
      clock.timer = undefined;
      if (needed()) void result.refetch({ cancelRefetch: false });
    };
    const delay = 750 - (Date.now() - clock.lastRequestAt);
    if (delay <= 0) refresh(); else clock.timer = setTimeout(refresh, delay);
  }, [enabled, viewerId, room.revision, clock, result.isFetching, result.dataUpdatedAt, result.errorUpdatedAt, result.refetch]);
  return result;
};
