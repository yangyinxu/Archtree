import { ObjectId, type Filter, type Document } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { applyRoomSafety, roomSafetyAccountIds } from '../application/rooms/roomLifecycle';
import { notifyRoomChanges } from '../realtime/roomEvents';
import type { RoomDocument } from '../repositories/social/roomDocuments';
import { ROOM_LIMITS } from '../contracts/roomV1';
import type { ListeningPublicationDocument } from '../repositories/social/listeningDocuments';
import { retireListeningPublication } from '../application/social/listeningLifecycle';

/** Session revocation and controller removal share one transaction across every login/logout/reset path. */
export const revokeSessionsWithRoomCleanup = async (
    filter: Filter<Document>, kind: 'session' | 'logoutAll' | 'otherSessions', accountId?: string, preservedSessionId?: string
): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number }> => {
    const db = getDb()!;
    const session = getDatabaseClient().startSession();
    let result = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    try {
        await session.withTransaction(async () => {
            result = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            const existing = await db.collection('authSessions').findOne(filter, { session });
            if (kind !== 'logoutAll' && !existing) return;
            const userId = accountId ?? existing?.userId;
            if (!userId || typeof userId !== 'string' || !/^[a-f0-9]{24}$/.test(userId)) return;
            const now = new Date();
            const publication = await db.collection<ListeningPublicationDocument>('socialListeningPublications').findOne({ _id: userId }, { session });
            const revokedPublisher = publication && (kind === 'logoutAll' || await db.collection('authSessions').findOne({
                $and: [filter, { _id: new ObjectId(publication.sessionId) }]
            }, { session, projection: { _id: 1 } }));
            let controllerSessions = kind === 'session' && existing ? [String(existing._id)] : [];
            if (kind === 'otherSessions') {
                if (!preservedSessionId) throw new Error('Other-session revocation requires the preserved session.');
                const rooms = await db.collection<RoomDocument>('socialRooms').find({ state: 'open', 'members.accountId': userId }, { session })
                    .limit(ROOM_LIMITS.activeRooms + 1).toArray();
                if (rooms.length > ROOM_LIMITS.activeRooms) throw new Error('Room cleanup bound exceeded.');
                const ids = rooms.flatMap(room => room.members.filter(member => member.accountId === userId)
                    .map(member => new ObjectId(member.controllerSessionId)));
                const revokedControllers = await db.collection('authSessions').find({ $and: [filter, { _id: { $in: ids } }] },
                    { session, projection: { _id: 1 } }).toArray();
                controllerSessions = revokedControllers.map(value => String(value._id));
            }
            const updated = kind !== 'session' ? await db.collection('authSessions').updateMany(filter,
                { $set: { revokedAt: now, updatedAt: now } }, { session }) : await db.collection('authSessions').updateOne(filter,
                { $set: { revokedAt: now, updatedAt: now } }, { session });
            result = { acknowledged: updated.acknowledged === true,
                matchedCount: Number(updated.matchedCount ?? 0), modifiedCount: Number(updated.modifiedCount ?? 0) };
            if (publication && revokedPublisher) await retireListeningPublication(publication, session, now.getTime());
            const ids = [...new Set([userId, ...await roomSafetyAccountIds(userId, session)])].sort();
            await db.collection('users').updateMany({ _id: { $in: ids.map(id => new ObjectId(id)) } },
                { $inc: { listenerMutationRevision: 1 } }, { session });
            if (kind === 'logoutAll') await applyRoomSafety({ kind, accountId: userId }, session, now.getTime());
            else for (const sessionId of controllerSessions) await applyRoomSafety({ kind: 'session', accountId: userId, sessionId }, session, now.getTime());
            await db.collection('socialRealtimeTickets').deleteMany({ accountId: userId,
                ...(kind === 'session' && existing ? { sessionId: String(existing._id) } : {}),
                ...(kind === 'otherSessions' ? { sessionId: { $ne: preservedSessionId } } : {}) }, { session });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5_000 });
        notifyRoomChanges();
        return result;
    } finally { await session.endSession(); }
};
