import { ObjectId, type Db } from 'mongodb';
import { catalogSearchCollections, catalogSearchProjection, type SearchCollection } from '../utils/catalogSearch';

export interface SearchBackfillOptions {
    collection: SearchCollection;
    limit: number;
    after?: string;
    apply: boolean;
}

/** Rebuilds a bounded source-checked page; retries cannot overwrite a concurrent rename. */
export const backfillCatalogSearch = async (
    db: Db,
    options: SearchBackfillOptions,
    beforeWrite?: () => Promise<void>
) => {
    if (!Object.prototype.hasOwnProperty.call(catalogSearchCollections, options.collection)
        || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500
        || (options.after !== undefined && !/^[a-f\d]{24}$/i.test(options.after))) {
        throw new Error('Invalid search backfill page.');
    }
    const field = catalogSearchCollections[options.collection];
    const collection = db.collection(options.collection);
    const rows = await collection.find(options.after ? { _id: { $gt: new ObjectId(options.after) } } : {})
        .project({ _id: 1, [field]: 1 }).sort({ _id: 1 })
        .limit(options.limit + 1).maxTimeMS(3_000).toArray();
    const page = rows.slice(0, options.limit);
    let updated = 0;
    let changedSources = 0;
    let indexed = 0;
    for (const row of page) {
        const projection = catalogSearchProjection(row[field]);
        if (projection.catalogSearchVersion === 1) indexed++;
        if (!options.apply) continue;
        await beforeWrite?.();
        const result = await collection.updateOne({
            _id: row._id,
            [field]: Object.prototype.hasOwnProperty.call(row, field) ? { $eq: row[field] } : { $exists: false }
        }, { $set: projection });
        if (result.matchedCount === 1) updated++;
        else changedSources++;
    }
    return {
        dryRun: !options.apply, scanned: page.length, indexed, fallback: page.length - indexed,
        updated, changedSources,
        nextCursor: rows.length > options.limit ? String(page[page.length - 1]._id) : null
    };
};
