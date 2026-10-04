import { getDb } from '../src/infrastructure/database';
import { escapeRegex } from '../src/utils/search';
import { catalogSearchFilter, catalogSearchProjection } from '../src/utils/catalogSearch';
import { startMongoReplicaSet } from '../test/support/mongoReplicaSet';

/** Measures the existing substring predicate against disposable synthetic data only. */
const profileSearch = async () => {
  const harness = await startMongoReplicaSet('archtree-search-profile');
  try {
    const collection = getDb()!.collection('syntheticSearchProfile');
    const count = 10_000;
    await collection.insertMany(Array.from({ length: count }, (_, index) => {
      const title = index >= count - 20 ? `Zneedle ${index}` : `Synthetic ${index}`;
      return { title, lifecycleStatus: 'ready', ...catalogSearchProjection(title) };
    }));
    const expression = { title: { $regex: escapeRegex('needle'), $options: 'i' }, lifecycleStatus: 'ready' };
    const results = [];
    for (const mode of ['unindexed', 'title-index', 'substring-index']) {
      if (mode === 'title-index') await collection.createIndex({ title: 1, _id: 1 });
      if (mode === 'substring-index') {
        await collection.createIndex({ catalogSearchVersion: 1 });
        await collection.createIndex({ catalogSearchGrams: 1, catalogSearchVersion: 1 });
      }
      const query = mode === 'substring-index'
        ? { lifecycleStatus: 'ready', ...catalogSearchFilter('title', 'needle', true) } : expression;
      const plan = await collection.find(query).sort({ title: 1, _id: 1 }).limit(20)
        .maxTimeMS(5_000).explain('executionStats');
      const stats = plan.executionStats;
      results.push({ mode, returned: stats.nReturned, documentsExamined: stats.totalDocsExamined,
        keysExamined: stats.totalKeysExamined, executionMilliseconds: stats.executionTimeMillis });
    }
    console.log(JSON.stringify({ workload: 'synthetic-substring-search', records: count, results }));
  } finally { await harness.stop(); }
};

void profileSearch().catch(() => {
  console.error(JSON.stringify({ category: 'synthetic_search_profile_failed' }));
  process.exitCode = 1;
});
