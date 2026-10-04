import { ROOM_LIMITS } from '../../contracts/roomV1';
import type { RoomDocument, RoomMemberDocument } from '../../repositories/social/roomDocuments';

/** A controller is live only while its socket is attached and its last confirmed heartbeat is inside the grace. */
export const roomMemberConnected = (member: Pick<RoomMemberDocument, 'connectionPresent' | 'lastSeenAt'>, now: number): boolean =>
    member.connectionPresent && now - member.lastSeenAt.getTime() < ROOM_LIMITS.hostGraceMs;

/**
 * Whether host absence currently holds shared playback.
 *
 * Absence is measured from the host controller's last confirmed heartbeat (or the recorded absence start),
 * never from when a sweep happens to notice it, so a delayed sweep can neither extend nor restart the grace.
 * Inside the grace the room keeps its timeline, preparation, natural advancement and mode permissions.
 * A recorded suspension outlives the host's return until the host explicitly starts playback again.
 */
export const roomHostPlaybackSuspended = (room: Pick<RoomDocument, 'members' | 'hostMembershipId' | 'hostAbsentSince' | 'hostSuspended'>,
    now: number): boolean => {
    if (room.hostSuspended) return true;
    const host = room.members.find(member => member.membershipId === room.hostMembershipId);
    if (!host) return true;
    if (roomMemberConnected(host, now)) return false;
    return now - (room.hostAbsentSince ?? host.lastSeenAt).getTime() >= ROOM_LIMITS.hostGraceMs;
};
