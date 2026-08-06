import { createHash } from 'node:crypto';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { touchActiveAccount } from './accountReferenceFenceService';

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

export interface AvatarMutationReservationDependencies {
    /** Test-only coordination point after the pending receipt is written. */
    afterReservationWritten?: () => Promise<void>;
}

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
    expectedRevision: number,
    dependencies: AvatarMutationReservationDependencies = {}
) => {
    const _id = mutationId(userId, idempotencyKey);
    const collection = getDb()!.collection<AvatarMutationRecord>('avatarMutations');
    await ensureExpirationIndex();
    const session = getDatabaseClient().startSession();
    let created = false;
    let existing: AvatarMutationRecord | null = null;
    let conflictingPending = false;
    try {
        await session.withTransaction(async () => {
            created = false;
            existing = null;
            conflictingPending = false;
            await touchActiveAccount(userId, session);
            existing = await collection.findOne({ _id }, { session });
            if (existing) return;
            conflictingPending = Boolean(await collection.findOne(
                { userId, status: 'pending' },
                { session, projection: { _id: 1 } }
            ));
            if (conflictingPending) return;

            const createdAt = new Date();
            await collection.insertOne({
                _id,
                userId,
                kind,
                expectedRevision,
                status: 'pending',
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000)
            }, { session });
            created = true;
            await dependencies.afterReservationWritten?.();
        });
    } finally {
        await session.endSession();
    }

    if (created) {
        return { mutationId: _id, isOwner: true, result: undefined };
    }
    if (conflictingPending) {
        return {
            mutationId: _id,
            isOwner: false,
            result: { statusCode: 409, body: { message: 'Another avatar operation is still in progress.' } }
        };
    }
    const prior = existing as AvatarMutationRecord | null;
    if (!prior || prior.userId !== userId
        || prior.kind !== kind || prior.expectedRevision !== expectedRevision) {
        return {
            mutationId: _id,
            isOwner: false,
            result: { statusCode: 409, body: { message: 'Idempotency key was reused for another operation.' } }
        };
    }
    if (prior.status === 'completed' && prior.result) {
        return { mutationId: _id, isOwner: false, result: prior.result };
    }
    return {
        mutationId: _id,
        isOwner: false,
        result: { statusCode: 409, body: { message: 'The avatar operation is still in progress.' } }
    };
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
