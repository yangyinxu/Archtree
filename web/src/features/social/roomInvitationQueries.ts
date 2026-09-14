import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRoomCapabilities, getRoomInvitations } from '../../api/rooms';
import { roomSession } from './roomSession';
import { useInvitationNow } from './useInvitationNow';
export { useInvitationNow } from './useInvitationNow';

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
      const state = roomSession.getSnapshot();
      const room = state.viewerId === viewerId ? state.room : null;
      void client.invalidateQueries({ queryKey: ['social', viewerId], predicate: query => {
        const key = String(query.queryKey[2]);
        // React may not have unmounted the former room yet when the authoritative singleton changes.
        if (key === 'room-community') return Boolean(room && room.status !== 'ended' && room.roomId === query.queryKey[3]
          && room.epoch === query.queryKey[4] && room.self.memberId === query.queryKey[5]);
        if (kind === 'community') return false;
        if (key === 'room-outgoing-invitations') return Boolean(room && room.status === 'open' && room.roomId === query.queryKey[3]
          && room.self.isController && room.hostMemberId === room.self.memberId);
        return key === 'room-invitations' || key === 'room-invitation'
          || kind === 'social' && !key.startsWith('room-');
      } });
    }, { realtimeEnabled: capabilities.data.roomsEnabled });
  }, [viewerId, client, capabilities.data]);
  return { ready: Boolean(capabilities.data), roomsEnabled: capabilities.data?.roomsEnabled ?? false,
    error: capabilities.isError, retry: capabilities.refetch };
};
