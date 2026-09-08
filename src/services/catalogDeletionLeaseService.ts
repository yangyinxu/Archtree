import { randomUUID } from 'node:crypto';
import { ClientSession, Document, ObjectId } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';

export type CatalogDeletionOwnerType = 'artist' | 'album';
/** A stopped worker becomes recoverable without trusting application host clocks. */
export const catalogDeletionLeaseMilliseconds = 120_000;

/** Survives owner removal until every prepared image lifecycle record is finalized. */
interface CatalogDeletionOperation {
    _id: string;
    ownerType: CatalogDeletionOwnerType;
    ownerId: string;
    referenceRevision: number;
    coverArtId?: string | null;
    preparedImageIds: string[];
    token: string;
    status: 'inProgress' | 'failed';
    leaseUntil: Date;
    updatedAt: Date;
}

/** Stops stale workers before they advance another deletion stage. */
export class CatalogDeletionLeaseLostError extends Error {
    readonly statusCode = 409;
    readonly code = 'catalog_deletion_lease_lost';
    readonly cleanupPending = true;

    constructor() {
        super('Catalog deletion ownership expired or changed. Retry the recorded operation.');
    }
}

/** Keeps the pre-lease compatibility recovery window consistent with administrator audits. */
export const catalogDeletionRecoveryReason = (owner: Document, now = new Date()) => {
    if (owner.lifecycleStatus === 'deleteFailed') return 'deleteFailed' as const;
    if (owner.lifecycleStatus !== 'deleting') return undefined;
    if (owner.lifecycleUpdatedAt == null
        || (owner.lifecycleUpdatedAt instanceof Date
            && owner.lifecycleUpdatedAt.getTime() <= now.getTime() - catalogDeletionLeaseMilliseconds)) {
        return 'legacyDeletion' as const;
    }
    return undefined;
};

/** Claims the operation and owner together; an active claim is always a conflict. */
export const acquireCatalogDeletionLease = async (
    ownerType: CatalogDeletionOwnerType,
    _id: ObjectId,
    options: { heartbeatMilliseconds?: number } = {}
) => {
    const db = getDb()!;
    const owners = db.collection(ownerType === 'artist' ? 'artists' : 'albums');
    const operations = db.collection<CatalogDeletionOperation>('catalogDeletionOperations');
    const operationId = `${ownerType}:${_id.toHexString()}`;
    const token = randomUUID();
    const session = getDatabaseClient().startSession();
    let claimed: CatalogDeletionOperation | undefined;
    let owner: Document | null = null;
    const busy = () => Object.assign(new Error(`${ownerType} deletion is already in progress.`), {
        statusCode: 409,
        code: `${ownerType}_deletion_in_progress`
    });
    try {
        await session.withTransaction(async () => {
            claimed = undefined;
            const previous = await operations.findOne({ _id: operationId }, { session });
            owner = await owners.findOne({ _id }, { session });
            if (!previous && !owner) return;

            const claim = await operations.updateOne({
                _id: operationId,
                ...(previous ? {
                    $or: [{ status: 'failed' }, { $expr: { $lte: ['$leaseUntil', '$$NOW'] } }]
                } : {})
            }, [{ $set: {
                ownerType,
                ownerId: _id.toHexString(),
                token,
                status: 'inProgress',
                leaseUntil: { $add: ['$$NOW', catalogDeletionLeaseMilliseconds] },
                updatedAt: '$$NOW',
                preparedImageIds: { $ifNull: ['$preparedImageIds', []] }
            } }], { session, upsert: !previous });
            if (previous && claim.matchedCount !== 1) throw busy();

            if (owner) {
                const transition = await owners.findOneAndUpdate({
                    _id,
                    $or: [
                        { lifecycleStatus: 'ready' },
                        { lifecycleStatus: 'deleteFailed' },
                        { lifecycleStatus: { $exists: false } },
                        ...(previous ? [{ lifecycleStatus: 'deleting' }] : [{
                            lifecycleStatus: 'deleting',
                            $or: [
                                { lifecycleUpdatedAt: null },
                                { lifecycleUpdatedAt: { $type: 'date' }, $expr: {
                                    $lte: ['$lifecycleUpdatedAt', { $subtract: ['$$NOW', catalogDeletionLeaseMilliseconds] }]
                                } }
                            ]
                        }])
                    ]
                }, [{ $set: {
                    lifecycleStatus: 'deleting',
                    lifecycleUpdatedAt: '$$NOW',
                    lifecycleError: null,
                    referenceRevision: { $add: [{ $ifNull: ['$referenceRevision', 0] }, 1] },
                    deletionLeaseToken: token
                } }], { session, returnDocument: 'after' });
                if (!transition.value) throw busy();
                owner = transition.value;
                await operations.updateOne({ _id: operationId, token }, { $set: {
                    referenceRevision: Number(owner.referenceRevision),
                    coverArtId: owner.coverArtId ?? null
                } }, { session });
            }
            claimed = (await operations.findOne({ _id: operationId, token }, { session }))!;
        });
    } catch (error: any) {
        if (error?.code === 11000) throw busy();
        throw error;
    } finally {
        await session.endSession();
    }
    if (!claimed) return null;
    const operation = claimed as CatalogDeletionOperation;
    const ownerFilter = {
        _id,
        lifecycleStatus: 'deleting',
        referenceRevision: operation.referenceRevision,
        deletionLeaseToken: token
    };
    const operationFilter = {
        _id: operationId,
        token,
        status: 'inProgress' as const,
        $expr: { $gt: ['$leaseUntil', '$$NOW'] }
    };
    let stopped = false;
    let heartbeatError: unknown;
    let heartbeat: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** A transactional lease write fences the callback even if takeover races its commit. */
    const runFenced = async <T>(mutation: (session: ClientSession) => Promise<T>): Promise<T> => {
        if (stopped || heartbeatError) throw heartbeatError ?? new CatalogDeletionLeaseLostError();
        const activeSession = getDatabaseClient().startSession();
        let result: T | undefined;
        try {
            await activeSession.withTransaction(async () => {
                const renewed = await operations.updateOne(operationFilter, [{ $set: {
                    leaseUntil: { $add: ['$$NOW', catalogDeletionLeaseMilliseconds] },
                    updatedAt: '$$NOW'
                } }], { session: activeSession });
                if (renewed.matchedCount !== 1) throw new CatalogDeletionLeaseLostError();
                result = await mutation(activeSession);
            });
            return result as T;
        } finally {
            await activeSession.endSession();
        }
    };
    const assertHeld = () => runFenced(async () => undefined);
    const schedule = () => {
        if (stopped || heartbeatError) return;
        timer = setTimeout(() => {
            heartbeat = assertHeld().catch((error) => { heartbeatError = error; })
                .finally(() => { heartbeat = undefined; schedule(); });
        }, options.heartbeatMilliseconds ?? catalogDeletionLeaseMilliseconds / 3);
        timer.unref();
    };
    schedule();

    return {
        owner: owner as Document | null,
        operation,
        ownerFilter,
        assertHeld,
        runFenced,
        /** S3 responses may arrive after takeover; their image state writes use the same fence. */
        updateImage: (imageId: string, update: Record<string, unknown>, expected: Record<string, unknown> = {}) =>
            runFenced((activeSession) => db.collection('imageAssets').updateOne({
                ...expected,
                _id: ObjectId.createFromHexString(imageId),
                ownerType,
                ownerId: { $in: [_id.toHexString(), _id] },
                s3Key: `images/${ObjectId.createFromHexString(imageId).toHexString()}`
            }, { $set: update }, { session: activeSession })),
        /** A historical late failure must be reconfirmed against S3, never deleted as evidence alone. */
        imagesNeedingPreparationRetry: (ids: readonly string[]) => runFenced(async (activeSession) => ids.length === 0 ? []
            : db.collection('imageAssets').find({
                _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
                uploadStatus: 'deleteFailed'
            }, { session: activeSession }).project({ _id: 1 }).limit(ids.length).toArray()),
        /** Durable preparation evidence must commit before the owner can disappear. */
        recordPreparedImages: (ids: string[]) => runFenced(async (activeSession) => {
            await operations.updateOne({ _id: operationId, token }, {
                $set: { preparedImageIds: ids }
            }, { session: activeSession });
        }),
        /** Finalize each exact owned asset and its receipt entry atomically behind the lease. */
        finalizeImages: async (ids: readonly string[]) => {
            for (const imageId of ids) {
                await runFenced(async (activeSession) => {
                    const imageObjectId = ObjectId.createFromHexString(imageId);
                    const images = db.collection('imageAssets');
                    const receipt = await operations.findOne({ _id: operationId, token }, { session: activeSession });
                    if (!receipt?.preparedImageIds.includes(imageId)) {
                        if (await images.findOne({ _id: imageObjectId }, { session: activeSession })) {
                            throw new Error('Cover-art preparation has not been recorded for this deletion.');
                        }
                        return;
                    }
                    const deleted = await images.deleteOne({
                        _id: imageObjectId,
                        ownerType,
                        ownerId: { $in: [_id.toHexString(), _id] },
                        s3Key: `images/${imageObjectId.toHexString()}`,
                        uploadStatus: 'deleting'
                    }, { session: activeSession });
                    if (deleted.deletedCount !== 1
                        && await images.findOne({ _id: imageObjectId }, { session: activeSession })) {
                        throw new Error('Prepared cover-art lifecycle identity or state changed.');
                    }
                    await operations.updateOne({ _id: operationId, token }, {
                        $pull: { preparedImageIds: imageId }
                    }, { session: activeSession });
                });
            }
        },
        fail: (error: unknown) => runFenced(async (activeSession) => {
            await owners.updateOne(ownerFilter, { $set: {
                lifecycleStatus: 'deleteFailed',
                lifecycleUpdatedAt: new Date(),
                lifecycleError: (error instanceof Error ? error.message : String(error)).slice(0, 500)
            } }, { session: activeSession });
            await operations.updateOne({ _id: operationId, token }, {
                $set: { status: 'failed' }
            }, { session: activeSession });
        }),
        /** Remove the receipt only after all prepared assets were confirmed finalized. */
        complete: () => runFenced(async (activeSession) => {
            const receipt = await operations.findOne({ _id: operationId, token }, { session: activeSession });
            if (!receipt || receipt.preparedImageIds.length > 0
                || await owners.findOne({ _id }, { session: activeSession })) {
                throw new Error('Catalog deletion still has an owner or prepared artwork to finalize.');
            }
            const removed = await operations.deleteOne({
                _id: operationId, token, preparedImageIds: { $size: 0 }
            }, { session: activeSession });
            if (removed.deletedCount !== 1) throw new CatalogDeletionLeaseLostError();
        }),
        stop: async () => {
            stopped = true;
            clearTimeout(timer);
            await heartbeat;
        }
    };
};
