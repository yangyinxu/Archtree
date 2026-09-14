import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { SocialError } from '../contracts/socialV1';

interface Lease { _id: string; owner: string; epoch: number; expiresAt: Date; fence: number }
const boundedCounter = { $gte: 0, $lt: Number.MAX_SAFE_INTEGER };
const integralCounters = { $and: [
    { $in: [{ $type: '$epoch' }, ['int', 'long', 'double']] },
    { $in: [{ $type: '$fence' }, ['int', 'long', 'double']] },
    { $eq: ['$epoch', { $trunc: '$epoch' }] }, { $eq: ['$fence', { $trunc: '$fence' }] }
] };
/** One process owns room scheduling; every transport/timer commit also writes this live database fence. */
export const createRoomAuthority = (owner = randomUUID()) => {
    let epoch: number | null = null;
    const leases = () => {
        const db = getDb();
        if (!db) throw new SocialError(503, 'room_authority_unavailable');
        return db.collection<Lease>('socialAuthority');
    };
    return {
        /** MongoDB time decides lease expiry; a retired process cannot rely on its local clock. */
        async acquire(): Promise<number | null> {
            try {
                // Provision by primary key first: MongoDB disallows $expr in an upsert predicate.
                await leases().updateOne({ _id: 'rooms-v1' }, { $setOnInsert: {
                    owner: '', epoch: 0, expiresAt: new Date(0), fence: 0
                } }, { upsert: true, writeConcern: { w: 'majority' } });
                const result = await leases().findOneAndUpdate({ _id: 'rooms-v1', epoch: boundedCounter, fence: boundedCounter,
                    $expr: integralCounters, $or: [
                    { owner }, { $expr: { $lte: ['$expiresAt', '$$NOW'] } }
                ] }, [{ $set: {
                    epoch: { $cond: [{ $and: [{ $eq: ['$owner', owner] }, { $gt: ['$expiresAt', '$$NOW'] }] },
                        '$epoch', { $add: [{ $ifNull: ['$epoch', 0] }, 1] }] },
                    owner, expiresAt: { $add: ['$$NOW', 10_000] }, fence: { $ifNull: ['$fence', 0] }
                } }], { returnDocument: 'after', writeConcern: { w: 'majority' } });
                const acquired = result.value;
                epoch = acquired && Number.isSafeInteger(acquired.epoch) && acquired.epoch > 0
                    && Number.isSafeInteger(acquired.fence) && acquired.fence >= 0 && acquired.fence < Number.MAX_SAFE_INTEGER
                    ? acquired.epoch : null;
                return epoch;
            } catch (error) {
                epoch = null;
                if ((error as { code?: number }).code === 11000) return null;
                throw new SocialError(503, 'room_authority_unavailable');
            }
        },
        async assert(session: ClientSession): Promise<number> {
            if (!session.inTransaction() || epoch === null || !Number.isSafeInteger(epoch) || epoch < 1) throw new SocialError(503, 'room_authority_unavailable');
            const captured = epoch;
            const result = await leases().updateOne({ _id: 'rooms-v1', owner, epoch: captured, fence: boundedCounter,
                $expr: { $and: [{ $gt: ['$expiresAt', '$$NOW'] }, integralCounters] } }, { $inc: { fence: 1 } }, { session });
            if (!result.matchedCount) throw new SocialError(503, 'room_authority_unavailable');
            return captured;
        },
        /** Conditional release cannot expire a lease already taken by a different process. */
        async release(): Promise<void> {
            const captured = epoch;
            epoch = null;
            if (captured === null) return;
            await leases().updateOne({ _id: 'rooms-v1', owner, epoch: captured },
                { $set: { expiresAt: new Date(0) } }, { writeConcern: { w: 'majority' } });
        }
    };
};

export const roomAuthority = createRoomAuthority();
export const assertRoomAuthority = (session: ClientSession) => roomAuthority.assert(session);
