import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { getDb } from '../src/infrastructure/database';
import { changePortfolio, createMongoPortfolioStore } from '../src/portfolio/portfolioStore';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;

before(async () => { harness = await startMongoReplicaSet('archtree-portfolio-store-test'); });
beforeEach(async () => { await getDb()!.collection('portfolioSettings').deleteMany({}); });
after(async () => { await harness?.stop(); });

test('the first write creates the settings document and a second creator loses', async () => {
    const store = createMongoPortfolioStore();
    assert.equal(await store.read(), null);
    assert.equal(await store.write(0, [{ slug: 'ootd', visibility: 'public' }], 'admin-1'), true);
    assert.equal(await store.write(0, [{ slug: 'finitude', visibility: 'hidden' }], 'admin-2'), false);

    const document = await getDb()!.collection('portfolioSettings').findOne({ _id: 'projects' as never });
    assert.equal(document?.revision, 1);
    assert.equal(document?.updatedBy, 'admin-1');
    assert.deepEqual(document?.projects, [{ slug: 'ootd', visibility: 'public' }]);
});

test('updates apply only at the expected revision', async () => {
    const store = createMongoPortfolioStore();
    assert.equal(await changePortfolio(store, 0, { kind: 'move', slug: 'ootd', direction: 'up' }, 'admin-1'), 'applied');
    assert.equal(await changePortfolio(store, 0, { kind: 'visibility', slug: 'ootd', visibility: 'public' }, 'admin-2'), 'stale');
    assert.equal(await changePortfolio(store, 1, { kind: 'visibility', slug: 'ootd', visibility: 'public' }, 'admin-2'), 'applied');
    assert.equal(await store.write(1, [], 'admin-3'), false);

    const stored = await store.read();
    assert.equal(stored?.revision, 2);
    const ootd = stored?.projects.find((entry) => entry.slug === 'ootd');
    assert.deepEqual(ootd, { slug: 'ootd', visibility: 'public' });
    assert.equal(stored?.projects.at(-2)?.slug, 'ootd');
});
