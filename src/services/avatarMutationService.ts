import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { touchActiveAccount } from './accountReferenceFenceService';

export type AvatarMutationKind = 'replace' | 'delete';
export type AvatarMutationResult = { statusCode: number; body?: Record<string, unknown> };
export type AvatarMutationPhase = 'reserved' | 'uploading' | 'uploaded' | 'promoted' | 'deleting' | 'cleared';

/** Pending receipts are durable recovery evidence; only completed responses expire. */
export type AvatarMutationRecord = {
    _id: string;
    userId: string;
    kind: AvatarMutationKind;
    expectedRevision: number;
    status: 'pending' | 'completed';
    phase?: AvatarMutationPhase;
    assetId?: string;
    previousAssetId?: string;
    leaseToken?: string;
    leaseUntil?: Date;
    result?: AvatarMutationResult;
    createdAt: Date;
    completedAt?: Date;
    expiresAt?: Date;
};
export type AvatarMutationLease = { mutationId: string; leaseToken: string; record: AvatarMutationRecord };
export const avatarLeaseMs = 30_000;

export class AvatarLeaseLostError extends Error {
    readonly statusCode = 409;
    readonly code = 'avatar_lease_lost';
    constructor() { super('Avatar operation was resumed by another request. Refresh the account.'); }
}

export interface AvatarMutationReservationDependencies {
    afterReservationWritten?: () => Promise<void>;
    db?: Db;
    client?: MongoClient;
    now?: () => Date;
    touchAccount?: typeof touchActiveAccount;
}

const initializations = new WeakMap<Db, Promise<unknown>>();
/** Startup migration removes the obsolete TTL from pending recovery evidence. */
export const initializeAvatarMutationRecovery = (db: Db) => {
    let initialization = initializations.get(db);
    if (!initialization) {
        initialization = (async () => {
            // The old schema placed a TTL on pending receipts. Preserve them before
            // attempting recovery, including records written by the preceding release.
            await db.collection('avatarMutations').updateMany(
                { status: 'pending', expiresAt: { $exists: true } }, { $unset: { expiresAt: '' } }
            );
            await db.collection('avatarMutations').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
            await db.collection('avatarMutations').createIndex({ userId: 1, status: 1 });
        })().catch(error => { initializations.delete(db); throw error; });
        initializations.set(db, initialization);
    }
    return initialization;
};
const mutationId = (userId: string, idempotencyKey: string) =>
    createHash('sha256').update(`${userId}\0${idempotencyKey}`).digest('hex');

/** Claims one account operation, or a stale operation that must finish before a new intent. */
export const beginAvatarMutation = async (
    userId: string, idempotencyKey: string, kind: AvatarMutationKind, expectedRevision: number,
    dependencies: AvatarMutationReservationDependencies = {}
) => {
    const db = dependencies.db ?? getDb()!;
    const collection = db.collection<AvatarMutationRecord>('avatarMutations');
    if (!dependencies.db) await initializeAvatarMutationRecovery(db);
    const session = (dependencies.client ?? getDatabaseClient()).startSession();
    const _id = mutationId(userId, idempotencyKey);
    const leaseToken = randomUUID();
    let outcome: { mutationId: string; isOwner: boolean; result?: AvatarMutationResult; lease?: AvatarMutationLease; recovery?: boolean } | undefined;
    try {
        await session.withTransaction(async () => {
            outcome = undefined;
            const now = dependencies.now?.() ?? new Date();
            await (dependencies.touchAccount ?? touchActiveAccount)(userId, session);
            const prior = await collection.findOne({ _id }, { session });
            if (prior && (prior.kind !== kind || prior.expectedRevision !== expectedRevision)) {
                outcome = { mutationId: _id, isOwner: false, result: { statusCode: 409, body: { message: 'Idempotency key was reused for another operation.' } } };
                return;
            }
            if (prior?.status === 'completed' && prior.result) {
                outcome = { mutationId: _id, isOwner: false, result: prior.result };
                return;
            }
            const pending = prior ?? await collection.findOne({ userId, status: 'pending' }, { session });
            if (pending) {
                const until = pending.leaseUntil ?? new Date((pending.createdAt instanceof Date ? pending.createdAt.getTime() : 0) + avatarLeaseMs);
                if (until > now) {
                    outcome = { mutationId: _id, isOwner: false, result: { statusCode: 409, body: { message: 'Another avatar operation is still in progress.' } } };
                    return;
                }
                const leaseUntil = new Date(now.getTime() + avatarLeaseMs);
                const claimed = await collection.updateOne(
                    { _id: pending._id, status: 'pending', leaseToken: pending.leaseToken ?? { $exists: false } },
                    { $set: { leaseToken, leaseUntil }, $unset: { expiresAt: '' } }, { session }
                );
                if (claimed.matchedCount !== 1) throw new AvatarLeaseLostError();
                const record = { ...pending, leaseToken, leaseUntil };
                outcome = { mutationId: pending._id, isOwner: true, recovery: true, lease: { mutationId: pending._id, leaseToken, record } };
                return;
            }
            const record: AvatarMutationRecord = {
                _id, userId, kind, expectedRevision, status: 'pending', phase: 'reserved',
                leaseToken, leaseUntil: new Date(now.getTime() + avatarLeaseMs), createdAt: now
            };
            await collection.insertOne(record, { session });
            await dependencies.afterReservationWritten?.();
            outcome = { mutationId: _id, isOwner: true, recovery: false, lease: { mutationId: _id, leaseToken, record } };
        });
    } finally { await session.endSession(); }
    if (!outcome) throw new AvatarLeaseLostError();
    return outcome as { mutationId: string; isOwner: boolean; result?: AvatarMutationResult; lease?: AvatarMutationLease; recovery?: boolean };
};

/** Fences every database side effect together with the lease, never just a preceding read. */
export const withAvatarMutationLease = async <T>(lease: AvatarMutationLease, mutation: (session: ClientSession) => Promise<T>, dependencies: AvatarMutationReservationDependencies = {}): Promise<T> => {
    const session = (dependencies.client ?? getDatabaseClient()).startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            await (dependencies.touchAccount ?? touchActiveAccount)(lease.record.userId, session);
            const now = dependencies.now?.() ?? new Date();
            const fenced = await (dependencies.db ?? getDb()!).collection('avatarMutations').updateOne(
                { _id: lease.mutationId, status: 'pending', leaseToken: lease.leaseToken, leaseUntil: { $gt: now } },
                { $set: { leaseUntil: new Date(now.getTime() + avatarLeaseMs) } }, { session }
            );
            if (fenced.matchedCount !== 1) throw new AvatarLeaseLostError();
            result = await mutation(session);
        });
    } finally { await session.endSession(); }
    return result as T;
};

export const setAvatarMutationPhase = async (
    lease: AvatarMutationLease, phase: AvatarMutationPhase,
    fields: Partial<Pick<AvatarMutationRecord, 'assetId' | 'previousAssetId'>> = {},
    mutation?: (session: ClientSession) => Promise<void>
) => {
    await withAvatarMutationLease(lease, async session => {
        await mutation?.(session);
        await getDb()!.collection('avatarMutations').updateOne(
            { _id: lease.mutationId, leaseToken: lease.leaseToken }, { $set: { phase, ...fields } }, { session }
        );
    });
    Object.assign(lease.record, { phase, ...fields });
};

/** A delayed response cannot complete or release a successor's lease. */
export const completeAvatarMutation = async (lease: AvatarMutationLease, result: AvatarMutationResult) => {
    await withAvatarMutationLease(lease, async session => {
        await getDb()!.collection('avatarMutations').updateOne(
            { _id: lease.mutationId, leaseToken: lease.leaseToken },
            { $set: { status: 'completed', result, completedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } },
            { session }
        );
    });
};

/** Only a never-dispatched reservation can be erased. Other phases remain recoverable. */
export const releaseAvatarMutation = async (lease: AvatarMutationLease) => {
    await withAvatarMutationLease(lease, async session => {
        if (lease.record.phase === 'reserved') {
            await getDb()!.collection('avatarMutations').deleteOne(
                { _id: lease.mutationId, leaseToken: lease.leaseToken, phase: 'reserved' }, { session }
            );
        } else {
            await getDb()!.collection('avatarMutations').updateOne(
                { _id: lease.mutationId, leaseToken: lease.leaseToken }, { $set: { leaseUntil: new Date(0) } }, { session }
            );
        }
    });
};

/** Renews while live; transient errors stop renewal and the next fenced write fails safely. */
export const keepAvatarMutationLease = (lease: AvatarMutationLease) => {
    const timer = setInterval(() => {
        void getDb()!.collection('avatarMutations').updateOne(
            { _id: lease.mutationId, status: 'pending', leaseToken: lease.leaseToken, leaseUntil: { $gt: new Date() } },
            { $set: { leaseUntil: new Date(Date.now() + avatarLeaseMs) } }
        ).catch(() => undefined);
    }, avatarLeaseMs / 3);
    timer.unref();
    return () => clearInterval(timer);
};
