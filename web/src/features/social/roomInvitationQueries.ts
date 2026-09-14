import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRoomCapabilities, getRoomInvitations } from '../../api/rooms';
import { roomSession } from './roomSession';

/** Removes logically expired invitations even when TTL cleanup emits no realtime invalidation. */
export const useInvitationNow = (expiresAtMs?: number) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = expiresAtMs === undefined ? setInterval(update, 1000)
      : setTimeout(update, Math.max(1, Math.min(2_147_483_647, expiresAtMs - Date.now() + 1)));
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer); clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expiresAtMs]);
  return now;
};

/** The shared, account-scoped preview backs both the global reminder and room surfaces. */
export const useRoomInvitations = (viewerId: string) => {
  const result = useQuery({
    queryKey: ['social', viewerId, 'room-invitations'],
    queryFn: ({ signal }) => getRoomInvitations(viewerId, signal),
    refetchInterval: 15_000, refetchOnWindowFocus: 'always', retry: false
  });
  const nextExpiry = result.data?.invitations.reduce((next, invitation) =>
    invitation.expiresAtMs > Date.now() ? Math.min(next, invitation.expiresAtMs) : next, Infinity);
  const now = useInvitationNow(Number.isFinite(nextExpiry) ? nextExpiry : undefined);
  return { ...result, data: !result.isError && result.data ? {
    invitations: result.data.invitations.filter(invitation => invitation.expiresAtMs > now)
  } : undefined };
};

/** Reuses one transport across routes; disabled rollout retains explicit safety actions without ticket retries. */
export const useRoomInvitationConnection = (viewerId: string) => {
  const client = useQueryClient();
  const capabilities = useQuery({
    queryKey: ['social', viewerId, 'room-capabilities'],
    queryFn: ({ signal }) => getRoomCapabilities(viewerId, signal),
    refetchInterval: 30_000, staleTime: 30_000, retry: false
  });
  useEffect(() => {
    if (!capabilities.data) return;
    roomSession.ensure(viewerId, kind => {
      void client.invalidateQueries({ queryKey: ['social', viewerId], predicate: query => {
        const key = String(query.queryKey[2]);
        return key === 'room-invitations' || key === 'room-invitation' || key === 'room-outgoing-invitations'
          || kind === 'social' && !key.startsWith('room-');
      } });
    }, { realtimeEnabled: capabilities.data.roomsEnabled });
  }, [viewerId, client, capabilities.data]);
  return { ready: Boolean(capabilities.data), roomsEnabled: capabilities.data?.roomsEnabled ?? false,
    error: capabilities.isError, retry: capabilities.refetch };
};
