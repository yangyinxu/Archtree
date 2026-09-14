import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { ROOM_LIMITS, type RoomCommunityEvent, type RoomReaction } from '../../contracts/roomV1';
import { SocialError } from '../../contracts/socialV1';
import { getDb } from '../../infrastructure/database';
import type { RoomDocument, RoomInvitationDocument, RoomOutboxDocument } from '../../repositories/social/roomDocuments';
import type { SocialOutboxDocument } from '../../repositories/social/socialDocuments';
import { suppressRoomListening } from '../social/listeningLifecycle';

/** Invitations publish only private, coalesced account refresh signals. */
export const invalidateInvitationAccounts = async (accountIds: string[], session: ClientSession, now: number): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Invitation invalidation requires a transaction.');
    const outbox = getDb()!.collection<SocialOutboxDocument>('socialOutbox');
    for (const accountId of [...new Set(accountIds)].sort()) {
        const old = await outbox.findOne({ _id: accountId }, { session });
        const revision = old ? incrementRoomVersion(old.revision) : 1;
        await outbox.replaceOne({ _id: accountId }, { accountId, revision, updatedAt: new Date(now) }, { session, upsert: true });
    }
};

/** Removes invitation evidence and publishes only coalesced, account-scoped invalidations. */
export const deleteRoomInvitations = async (filter: Filter<RoomInvitationDocument>, session: ClientSession, now: number): Promise<void> => {
    const invitations = getDb()!.collection<RoomInvitationDocument>('socialInvitations');
    const maximum = ROOM_LIMITS.activeRooms * ROOM_LIMITS.invitations;
    const removed = await invitations.find(filter, { session }).limit(maximum + 1).toArray();
    if (removed.length > maximum) throw new SocialError(503, 'room_unavailable');
    if (!removed.length) return;
    await invitations.deleteMany(filter, { session });
    await invalidateInvitationAccounts(removed.flatMap(value => [value.senderAccountId, value.recipientAccountId]), session, now);
};

/** Refuses counter wrap: an exhausted room can no longer accept a ambiguous generation. */
export const incrementRoomVersion = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new SocialError(503, 'room_unavailable');
    return value + 1;
};
export const roomPositionAt = (room: RoomDocument, now: number): number => {
    const entry = room.queue.find(value => value.entryId === room.timeline.entryId);
    return Math.min(entry?.durationMs ?? 0, room.timeline.positionMs
        + (room.timeline.state === 'playing' ? Math.max(0, now - room.timeline.anchorServerTimeMs) : 0));
};

/** Cancels every timer/readiness identity that relied on a previous playback occurrence. */
export const pauseRoom = (room: RoomDocument, now: number): void => {
    room.timeline = { ...room.timeline, state: 'paused', positionMs: Math.floor(roomPositionAt(room, now)), anchorServerTimeMs: now };
    room.preparation = null;
    room.playbackGeneration = incrementRoomVersion(room.playbackGeneration);
};

/** Notices are appended by accepted action branches, never by generic persistence or delivery. */
export const appendRoomEvent = (room: RoomDocument, kind: RoomCommunityEvent['kind'], actorMembershipId: string | null,
    now: number, reaction: RoomReaction | null = null): void => {
    room.events = [...(room.events ?? []).filter(event => event.expiresAt.getTime() > now
        && (event.actorMembershipId === null || room.members.some(member => member.membershipId === event.actorMembershipId))),
    { eventId: `ev_${randomBytes(16).toString('hex')}`, kind, actorMembershipId, reaction,
        createdAt: new Date(now), expiresAt: new Date(now + ROOM_LIMITS.eventMs) }].slice(-ROOM_LIMITS.events);
};

/** Persists one complete state and an invalidation without retaining a private historical snapshot. */
export const persistRoom = async (room: RoomDocument, session: ClientSession, now: number): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Room persistence requires a transaction.');
    room.revision = incrementRoomVersion(room.revision);
    const db = getDb()!;
    await db.collection<RoomDocument>('socialRooms').replaceOne({ _id: room._id }, room, { session });
    await db.collection<RoomOutboxDocument>('socialRoomOutbox').updateOne({ _id: room._id }, {
        $set: { roomId: room._id, epoch: room.epoch, revision: room.revision, updatedAt: new Date(now) }
    }, { session, upsert: true });
};

/** Ending a room atomically frees every participation slot and removes all retained member identities. */
export const closeRoom = async (room: RoomDocument, session: ClientSession, now: number): Promise<void> => {
    if (room.state === 'closed') return;
    const db = getDb()!;
    await db.collection('socialRoomParticipation').deleteMany({ roomId: room._id }, { session });
    for (const member of room.members) await suppressRoomListening(room._id, member, session);
    await deleteRoomInvitations({ roomId: room._id }, session, now);
    pauseRoom(room, now);
    room.state = 'closed'; room.closedAt = new Date(now);
    room.members = []; room.queue = []; room.songRequests = []; room.events = []; room.transfer = null;
    room.hostMembershipId = ''; room.hostAbsentSince = null;
    room.timeline = { entryId: '', state: 'ended', positionMs: 0, anchorServerTimeMs: now };
    await persistRoom(room, session, now);
};

/** A member incarnation is removed once; deleting a stale slot cannot affect a later admission. */
export const removeRoomMember = async (room: RoomDocument, memberId: string, session: ClientSession, now: number): Promise<void> => {
    const member = room.members.find(value => value.membershipId === memberId);
    if (!member) return;
    if (room.hostMembershipId === memberId) return closeRoom(room, session, now);
    await suppressRoomListening(room._id, member, session);
    await getDb()!.collection('socialRoomParticipation').deleteOne({ _id: member.accountId, roomId: room._id, membershipId: memberId }, { session });
    room.members = room.members.filter(value => value.membershipId !== memberId);
    room.songRequests = (room.songRequests ?? []).filter(value => value.requesterMembershipId !== memberId);
    room.events = (room.events ?? []).filter(value => value.actorMembershipId !== memberId);
    for (const entry of room.queue) if (entry.requesterMembershipId === memberId) delete entry.requesterMembershipId;
    if (room.transfer?.targetMembershipId === memberId) room.transfer = null;
    if (room.preparation) room.preparation.cohort = room.preparation.cohort.filter(value => value.membershipId !== memberId);
    await persistRoom(room, session, now);
};

export interface RoomSafetyChange {
    kind: 'block' | 'deactivate' | 'delete' | 'logoutAll' | 'session' | 'removeFriend' | 'profile';
    accountId: string;
    targetAccountId?: string;
    sessionId?: string;
}

/** Resolves additional account fences before a social mutation acquires its sorted write set. */
export const roomSafetyAccountIds = async (accountId: string, session: ClientSession): Promise<string[]> => {
    const rooms = await getDb()!.collection<RoomDocument>('socialRooms')
        .find({ state: 'open', 'members.accountId': accountId }, { session }).limit(ROOM_LIMITS.activeRooms + 1).toArray();
    if (rooms.length > ROOM_LIMITS.activeRooms) throw new SocialError(503, 'room_unavailable');
    return [...new Set(rooms.flatMap(room => room.members.map(member => member.accountId)))].sort();
};

/** Enlists deny-only graph/account/session changes; it never starts a nested transaction or needs a leader. */
export const applyRoomSafety = async (change: RoomSafetyChange, session: ClientSession, now = Date.now()): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Room safety requires the caller transaction.');
    const db = getDb()!;
    const rooms = await db.collection<RoomDocument>('socialRooms')
        .find({ state: 'open', 'members.accountId': change.accountId }, { session }).limit(ROOM_LIMITS.activeRooms + 1).toArray();
    if (rooms.length > ROOM_LIMITS.activeRooms) throw new SocialError(503, 'room_unavailable');
    const accounts = [...new Set(rooms.flatMap(room => room.members.map(member => member.accountId)))].sort();
    if (accounts.length) await db.collection('users').updateMany({ _id: { $in: accounts.map(id => new ObjectId(id)) } },
        { $inc: { listenerMutationRevision: 1 } }, { session });
    const invitationFilter = change.targetAccountId
        ? { $or: [{ senderAccountId: change.accountId, recipientAccountId: change.targetAccountId },
            { senderAccountId: change.targetAccountId, recipientAccountId: change.accountId }] }
        : { $or: [{ senderAccountId: change.accountId }, { recipientAccountId: change.accountId }] };
    if (change.kind !== 'session' && change.kind !== 'profile') await deleteRoomInvitations(invitationFilter, session, now);
    if (change.kind === 'removeFriend') return;
    for (const room of rooms) {
        const member = room.members.find(value => value.accountId === change.accountId)!;
        if (change.kind === 'profile') {
            await persistRoom(room, session, now);
        } else if (change.kind === 'block') {
            const target = room.members.find(value => value.accountId === change.targetAccountId);
            if (!target) continue;
            await removeRoomMember(room, room.hostMembershipId === member.membershipId ? target.membershipId : member.membershipId, session, now);
        } else if (change.kind === 'session') {
            if (member.controllerSessionId !== change.sessionId) continue;
            member.connectionPresent = false;
            member.readyPlaybackGeneration = undefined;
            if (room.hostMembershipId === member.membershipId) {
                room.hostAbsentSince = member.lastSeenAt;
                if (room.preparation) pauseRoom(room, now);
            }
            await persistRoom(room, session, now);
        } else {
            await removeRoomMember(room, member.membershipId, session, now);
        }
    }
    if (change.kind === 'delete') await db.collection('socialRoomParticipation').deleteOne({ _id: change.accountId }, { session });
};

/** Media publication/deletion invalidates old room bytes in the same source transaction. */
export const invalidateRoomsForMedia = async (mediaTrackId: string, session: ClientSession, now = Date.now()): Promise<void> => {
    if (!session.inTransaction()) throw new Error('Room media invalidation requires a transaction.');
    const rooms = await getDb()!.collection<RoomDocument>('socialRooms')
        .find({ state: 'open', $or: [{ 'queue.mediaTrackId': mediaTrackId }, { 'songRequests.mediaTrackId': mediaTrackId }] }, { session })
        .limit(ROOM_LIMITS.activeRooms + 1).toArray();
    if (rooms.length > ROOM_LIMITS.activeRooms) throw new SocialError(503, 'room_unavailable');
    for (const room of rooms) {
        const queued = room.queue.some(entry => entry.mediaTrackId === mediaTrackId);
        room.songRequests = (room.songRequests ?? []).filter(request => request.mediaTrackId !== mediaTrackId);
        if (queued) {
            room.queue.forEach(entry => { if (entry.mediaTrackId === mediaTrackId) entry.unavailable = true; });
            if (room.queue.some(entry => entry.entryId === room.timeline.entryId && entry.mediaTrackId === mediaTrackId)) pauseRoom(room, now);
            room.queueRevision = incrementRoomVersion(room.queueRevision);
        }
        await persistRoom(room, session, now);
    }
};
