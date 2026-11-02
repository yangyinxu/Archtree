import { ObjectId, type ClientSession } from 'mongodb';
import {
    AdminCatalogError,
    adminCatalogMutation,
    pageSnapshot,
    withCurrentAdministrator
} from '../../administration/catalog/adminCatalogService';
import { getDb } from '../../infrastructure/database';
import { pageItemIdentity } from '../../utils/pageItemIdentity';

/** A confirmed order has the same private Page snapshot and receipt as other Page commands. */
type PageOrderResult = {
    page: Awaited<ReturnType<typeof pageSnapshot>>;
    receipt: { operationId: string };
};

/** Rejects malformed or incomplete orders before they can replace persistent composition. */
function fail(code = 'ADMIN_CATALOG_INVALID_INPUT', status = 400): never {
    throw new AdminCatalogError(status, code);
}

/** Fences the names and source states reviewed without requiring broken references to become ready. */
const fenceReviewedReferences = async (snapshot: PageOrderResult['page'], session: ClientSession) => {
    const items: Array<{ itemType: string; referenceStatus: string; referenceId: string }> = snapshot.items;
    for (const carousel of [true, false]) {
        const referenceIds = [...new Set<string>(items
            .filter(item => (item.itemType === 'carousel') === carousel && item.referenceStatus !== 'missing')
            .map(item => item.referenceId))];
        if (!referenceIds.length) continue;
        const touched = await getDb()!.collection(carousel ? 'carousels' : 'contentCollections').updateMany(
            { _id: { $in: referenceIds.map(id => new ObjectId(id)) } },
            { $inc: { referenceRevision: 1 } },
            { session }
        );
        if (touched.matchedCount !== referenceIds.length) fail('ADMIN_CATALOG_REVISION_CONFLICT', 409);
    }
};

/** Atomically saves the approved complete placement order and its immutable retry receipt. */
export const reorderAdminPage = (actor: string, slug: string, raw: unknown): Promise<PageOrderResult> => {
    if (slug !== 'home' && slug !== 'library') fail();
    const body = adminCatalogMutation.parse(raw, ['itemIds']);
    if (!Array.isArray(body.itemIds) || body.itemIds.length > 1000
        || body.itemIds.some(value => typeof value !== 'string' || !/^[0-9a-f]{24}$/.test(value))
        || new Set(body.itemIds).size !== body.itemIds.length) fail();
    // Copy the input before asynchronous work so the admitted intent cannot be changed by its caller.
    const itemIds = [...body.itemIds] as string[];
    const intent = { operationId: body.operationId, expectedRevision: body.expectedRevision, itemIds };
    const fingerprint = adminCatalogMutation.fingerprint(['page.order', slug, intent]);
    return withCurrentAdministrator(actor, async session => {
        const previous = await adminCatalogMutation.replay(actor, intent, fingerprint, session);
        if (previous) return previous as PageOrderResult;
        const page = await getDb()!.collection('pages').findOne({ slug }, { session });
        if (!page) return fail('ADMIN_CATALOG_NOT_FOUND', 404);
        const snapshot = await pageSnapshot(page, session);
        if (snapshot.revision !== intent.expectedRevision) fail('ADMIN_CATALOG_REVISION_CONFLICT', 409);
        if (!Array.isArray(page.items)) fail('ADMIN_PAGE_ITEM_IDENTITY_CONFLICT', 409);
        const byIdentity = new Map<string, Record<string, unknown>>();
        // The raw array is authoritative: a DTO can omit malformed rows and cannot define a complete permutation.
        for (const item of page.items) {
            const itemId = pageItemIdentity(item);
            if (!itemId || !['carousel', 'grid', 'list'].includes(item?.itemType) || byIdentity.has(itemId)) {
                fail('ADMIN_PAGE_ITEM_IDENTITY_CONFLICT', 409);
            }
            byIdentity.set(itemId, item);
        }
        if (itemIds.length !== byIdentity.size || itemIds.some(itemId => !byIdentity.has(itemId))) fail();
        await fenceReviewedReferences(snapshot, session);
        // A unique legacy fallback becomes its persisted ID, preserving the exact identity the admin approved.
        const items = itemIds.map((itemId, order) => ({ ...byIdentity.get(itemId)!, itemId, order }));
        const updated = await getDb()!.collection('pages').updateOne({ _id: page._id }, {
            $set: { items, updatedAt: new Date(), updatedBy: actor }
        }, { session });
        if (updated.matchedCount !== 1) fail('ADMIN_CATALOG_REVISION_CONFLICT', 409);
        const result = { page: await pageSnapshot({ ...page, items }, session), receipt: { operationId: intent.operationId } };
        await adminCatalogMutation.receipt(actor, intent, fingerprint, result, session);
        return result;
    });
};
