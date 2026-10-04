import { ObjectId } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { touchActiveAccount } from './accountReferenceFenceService';
import { touchReadyCatalogItemReferences } from './catalogItemReferenceFenceService';

interface CompositionItem { contentType: string; contentId: string; order: number }
interface ManualCompositionOwner<T extends CompositionItem> {
    _id: ObjectId;
    mode: string;
    items?: T[];
    contentType?: unknown;
}
export interface ManualCompositionHooks {
    /** Test barriers run inside the transaction and may be invoked again on retry. */
    afterRead?: () => Promise<void>;
    afterWrites?: () => Promise<void>;
}

export class ManualCompositionConflictError extends Error {
    readonly statusCode = 409;
    readonly code = 'manual_composition_changed';
    readonly data = { code: this.code };
    constructor() { super('The collection changed during this edit. Refresh it before trying again.'); }
}

/** Reads, prepares and commits all owners together; index-based edits cannot target a different item on retry. */
export const mutateManualComposition = async <T extends CompositionItem>(
    collectionName: 'carousels' | 'contentCollections',
    ids: string[],
    updatedBy: string,
    prepare: (owners: ManualCompositionOwner<T>[]) => T[][] | null,
    preserveObservedOrder = false,
    hooks: ManualCompositionHooks = {}
): Promise<T[][] | null> => {
    if (ids.length < 1 || ids.length > 2 || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) return null;
    const objectIds = ids.map(id => ObjectId.createFromHexString(id));
    const session = getDatabaseClient().startSession();
    let result: T[][] | null = null;
    let observedOrder: string | undefined;
    try {
        await session.withTransaction(async () => {
            result = null;
            const collection = getDb()!.collection(collectionName);
            const owners = [];
            for (const _id of objectIds) {
                const owner = await collection.findOne({ _id, mode: 'manual' }, { session });
                if (!owner) return;
                owners.push(owner);
            }
            const order = JSON.stringify(owners.map(owner => owner.items));
            if (preserveObservedOrder && observedOrder !== undefined && observedOrder !== order) {
                throw new ManualCompositionConflictError();
            }
            observedOrder = order;
            const prepared = prepare(owners as unknown as ManualCompositionOwner<T>[]);
            if (!prepared || prepared.length !== owners.length || prepared.some(items => items.length > 500)) return;
            await hooks.afterRead?.();
            await touchActiveAccount(updatedBy, session);
            const normalized = await touchReadyCatalogItemReferences(prepared.flat(), session);
            let offset = 0;
            const groups: T[][] = [];
            for (let index = 0; index < owners.length; index++) {
                const items = normalized.slice(offset, offset + prepared[index].length)
                    .map((item, order) => ({ ...item, order })) as unknown as T[];
                offset += items.length;
                const written = await collection.updateOne(
                    { _id: objectIds[index], mode: 'manual' },
                    { $set: { items, updatedBy, updatedAt: new Date() } },
                    { session }
                );
                if (written.matchedCount !== 1) throw new ManualCompositionConflictError();
                groups.push(items);
            }
            await hooks.afterWrites?.();
            result = groups;
        });
    } finally { await session.endSession(); }
    return result;
};
