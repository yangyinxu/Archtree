import { createHash } from 'node:crypto';
import { getDb } from '../infrastructure/database';

export type AvatarMutationKind = 'replace' | 'delete';
export type AvatarMutationResult = { statusCode: number; body?: Record<string, unknown> };

type AvatarMutationRecord = {
    _id: string;
    userId: string;
    kind: AvatarMutationKind;
    expectedRevision: number;
    status: 'pending' | 'completed';
    result?: AvatarMutationResult;
    createdAt: Date;
    completedAt?: Date;
    expiresAt: Date;
};

let indexPromise: Promise<string> | null = null;

const ensureExpirationIndex = () => {
    if (!indexPromise) {
        indexPromise = getDb()!.collection('avatarMutations').createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0 }
        );
    }
    return indexPromise;
};

const mutationId = (userId: string, idempotencyKey: string) => {
    return createHash('sha256').update(`${userId}\0${idempotencyKey}`).digest('hex');
};

/** Reserves a mutation once across instances and replays its confirmed result on retry. */
export const beginAvatarMutation = async (
    userId: string,
    idempotencyKey: string,
    kind: AvatarMutationKind,
    expectedRevision: number
) => {
    const _id = mutationId(userId, idempotencyKey);
    const collection = getDb()!.collection<AvatarMutationRecord>('avatarMutations');
    await ensureExpirationIndex();
    try {
        const createdAt = new Date();
        await collection.insertOne({
            _id,
            userId,
            kind,
            expectedRevision,
            status: 'pending',
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000)
        });
        return { mutationId: _id, isOwner: true, result: undefined };
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
        const existing = await collection.findOne({ _id });
        if (!existing || existing.userId !== userId
            || existing.kind !== kind || existing.expectedRevision !== expectedRevision) {
            return {
                mutationId: _id,
                isOwner: false,
                result: { statusCode: 409, body: { message: 'Idempotency key was reused for another operation.' } }
            };
        }
        if (existing.status === 'completed' && existing.result) {
            return { mutationId: _id, isOwner: false, result: existing.result };
        }
        return {
            mutationId: _id,
            isOwner: false,
            result: { statusCode: 409, body: { message: 'The avatar operation is still in progress.' } }
        };
    }
};

export const completeAvatarMutation = async (id: string, result: AvatarMutationResult) => {
    await getDb()!.collection<AvatarMutationRecord>('avatarMutations').updateOne(
        { _id: id, status: 'pending' },
        {
            $set: {
                status: 'completed',
                result,
                completedAt: new Date(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
            }
        }
    );
};

/** Releases operations that failed before a server-confirmed mutation so retry can resume. */
export const releaseAvatarMutation = async (id: string) => {
    await getDb()!.collection<AvatarMutationRecord>('avatarMutations').deleteOne({
        _id: id,
        status: 'pending'
    });
};
