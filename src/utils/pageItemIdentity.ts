import { ObjectId } from 'mongodb';

const objectIdPattern = /^[0-9a-f]{24}$/i;

/** Creates the persisted identity used to address one Page reference independently of order. */
export const newPageItemId = () => new ObjectId().toHexString();

/** Preserves valid unique identities and backfills every missing or conflicting item ID. */
export const withPersistedPageItemIds = <T extends { itemId?: unknown }>(items: T[]) => {
    const usedIds = new Set<string>();
    return items.map((item) => {
        const candidate = String(item.itemId ?? '').trim().toLowerCase();
        const itemId = objectIdPattern.test(candidate) && !usedIds.has(candidate)
            ? candidate
            : newPageItemId();
        usedIds.add(itemId);
        return { ...item, itemId };
    });
};

/**
 * Reads a persisted Page-item identity, falling back to the referenced definition
 * ID for legacy records that predate item IDs. The fallback is deliberately not
 * derived from order, so reordering cannot silently retarget a cursor.
 */
export const pageItemIdentity = (item: any) => {
    const persisted = String(item?.itemId ?? '').trim().toLowerCase();
    if (objectIdPattern.test(persisted)) return persisted;

    const definitionId = item?.itemType === 'carousel'
        ? String(item?.carouselId ?? '').trim().toLowerCase()
        : item?.itemType === 'grid' || item?.itemType === 'list'
            ? String(item?.collectionId ?? '').trim().toLowerCase()
            : '';
    return objectIdPattern.test(definitionId) ? definitionId : null;
};
