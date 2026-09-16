import { connectToDatabase, disconnectFromDatabase } from '../src/infrastructure/database';
import { backfillCatalogSearch } from '../src/services/catalogSearchBackfillService';
import { catalogSearchCollections, type SearchCollection } from '../src/utils/catalogSearch';

/** Explicit operational pages never initialize schema or print catalog metadata. */
const run = async () => {
    try {
        const args = new Map<string, string>();
        for (const raw of process.argv.slice(2)) {
            const match = /^(--[a-z-]+)(?:=(.*))?$/.exec(raw);
            if (!match || !['--collection', '--limit', '--after', '--apply', '--confirm'].includes(match[1])
                || args.has(match[1])) throw new Error('Invalid arguments.');
            args.set(match[1], match[2] ?? 'true');
        }
        const collection = args.get('--collection') ?? '';
        const limit = Number(args.get('--limit') ?? 100);
        const after = args.get('--after');
        const apply = args.has('--apply');
        if (!Object.prototype.hasOwnProperty.call(catalogSearchCollections, collection)
            || !Number.isInteger(limit) || limit < 1 || limit > 500
            || (after !== undefined && !/^[a-f\d]{24}$/i.test(after))
            || (apply && (args.get('--apply') !== 'true' || args.get('--confirm') !== 'APPLY_CATALOG_SEARCH'))) {
            throw new Error('Invalid arguments.');
        }
        const db = await connectToDatabase({ initializeIndexes: false, logReady: false });
        console.log(JSON.stringify(await backfillCatalogSearch(db, {
            collection: collection as SearchCollection, limit, after, apply
        })));
    } catch {
        console.error('Search backfill failed. Use --collection=artists|organizations|albums|audioTracks and --limit=1..500; apply additionally requires --apply --confirm=APPLY_CATALOG_SEARCH. Check database availability before retrying the same page.');
        process.exitCode = 1;
    } finally { await disconnectFromDatabase(); }
};
void run().catch(() => { console.error('Search backfill cleanup failed.'); process.exitCode = 1; });
