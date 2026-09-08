import { getDb } from '../src/infrastructure/database';
import { escapeRegex } from '../src/utils/search';
import { startMongoReplicaSet } from '../test/support/mongoReplicaSet';

/** Measures the existing substring predicate against disposable synthetic data only. */
const profileSearch = async () => {
  const harness = await startMongoReplicaSet('archtree-search-profile');
  try {
    const collection = getDb()!.collection('syntheticSearchProfile');
    const count = 10_000;
    await collection.insertMany(Array.from({ length: count }, (_, index) => ({
      title: index >= count - 20 ? `Zneedle ${index}` : `Synthetic ${index}`,
      lifecycleStatus: 'ready'
    })));
    const expression = { title: { $regex: escapeRegex('needle'), $options: 'i' }, lifecycleStatus: 'ready' };
    const results = [];
    for (const indexed of [false, true]) {
      if (indexed) await collection.createIndex({ title: 1, _id: 1 });
      const plan = await collection.find(expression).sort({ title: 1, _id: 1 }).limit(20)
        .maxTimeMS(5_000).explain('executionStats');
      const stats = plan.executionStats;
      results.push({ indexed, returned: stats.nReturned, documentsExamined: stats.totalDocsExamined,
        keysExamined: stats.totalKeysExamined, executionMilliseconds: stats.executionTimeMillis });
    }
    console.log(JSON.stringify({ workload: 'synthetic-substring-search', records: count, results }));
  } finally { await harness.stop(); }
};

void profileSearch().catch(() => {
  console.error(JSON.stringify({ category: 'synthetic_search_profile_failed' }));
  process.exitCode = 1;
});
