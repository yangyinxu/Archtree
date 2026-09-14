import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import type { RoomActor } from '../contracts/roomV1';
import { SocialError } from '../contracts/socialV1';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { touchActiveAccount } from '../services/accountReferenceFenceService';

interface Ticket { _id: string; accountId: string; sessionId: string; clientId: string; origin: string; expiresAt: Date }
const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
/** Live session fences apply both at ticket issuance and one-time upgrade redemption. */
export const fenceRoomSession = async (actor: RoomActor, session: ClientSession) => {
    if (!/^[a-f0-9]{24}$/.test(actor.userId) || !/^[a-f0-9]{24}$/.test(actor.sessionId)) throw new SocialError(401, 'session_required');
    const db = getDb()!;
    const result = await db.collection('authSessions').updateOne({ _id: new ObjectId(actor.sessionId), userId: actor.userId,
        revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }, { $inc: { socialMutationRevision: 1 } }, { session });
    if (!result.matchedCount) throw new SocialError(401, 'session_required');
    await touchActiveAccount(actor.userId, session);
};

/** Tickets never appear in URL parameters and only their digest is stored. */
export const issueRoomTicket = async (actor: RoomActor, origin: string) => {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 30_000);
    const session = getDatabaseClient().startSession();
    try {
        await session.withTransaction(async () => {
            await fenceRoomSession(actor, session);
            const collection = getDb()!.collection<Ticket>('socialRealtimeTickets');
            await collection.deleteMany({ accountId: actor.userId, expiresAt: { $lte: new Date() } }, { session });
            if (await collection.countDocuments({ accountId: actor.userId }, { session, limit: 5 }) >= 5) throw new SocialError(429, 'ticket_limit');
            await collection.insertOne({ _id: digest(ticket), accountId: actor.userId, sessionId: actor.sessionId,
                clientId: actor.clientId, origin, expiresAt }, { session });
        }, { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' }, maxCommitTimeMS: 5_000 });
        return { ticket, expiresAt: expiresAt.toISOString() };
    } finally { await session.endSession(); }
};

/** A consumed, expired, wrong-origin or revoked ticket cannot authorize even an observer socket. */
export const redeemRoomTicket = async (ticket: string, origin: string): Promise<RoomActor | null> => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const session = getDatabaseClient().startSession();
    let actor: RoomActor | null = null;
    try {
        await session.withTransaction(async () => {
            actor = null;
            const collection = getDb()!.collection<Ticket>('socialRealtimeTickets');
            const row = await collection.findOne({ _id: digest(ticket), origin, expiresAt: { $gt: new Date() } }, { session });
            if (!row) return;
            const identity = { userId: row.accountId, sessionId: row.sessionId, clientId: row.clientId };
            await fenceRoomSession(identity, session);
            const consumed = await collection.deleteOne({ _id: row._id, origin, expiresAt: { $gt: new Date() } }, { session });
            if (consumed.deletedCount) actor = identity;
        }, { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' }, maxCommitTimeMS: 5_000 });
        return actor;
    } catch { return null; } finally { await session.endSession(); }
};
