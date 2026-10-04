import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { Organization } from '../src/models/organization';
import { AudioTrack, AudioFormat } from '../src/models/audioTrack';
import { SimpleDate } from '../src/models/simpleDate';
import { catalogSearchFilter, catalogSearchProjection } from '../src/utils/catalogSearch';
import { escapeRegex } from '../src/utils/search';
import { backfillCatalogSearch } from '../src/services/catalogSearchBackfillService';
import { searchListenerContent } from '../src/services/listenerContentService';
import { searchPublicCatalog } from '../src/services/publicCatalogService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
before(async () => { harness = await startMongoReplicaSet('archtree-search-test'); });
after(async () => { await harness?.stop(); });

test('indexed and legacy search preserve exact case-insensitive substring matches and ready filtering', async () => {
    const rows = ['Needle', 'prefix nEeDlE suffix', 'n.*e', '周杰伦', 'Kelvin', 'ſong', 'İ', 'é', 'a'.repeat(513)]
        .flatMap(title => [
            { title, lifecycleStatus: 'ready', ...catalogSearchProjection(title) },
            { title, lifecycleStatus: 'ready' },
            { title, lifecycleStatus: 'deleting', ...catalogSearchProjection(title) }
        ]);
    const c = getDb()!.collection('searchSemantics');
    await c.insertMany(rows);
    for (const query of ['needle', 'e', 'NE', '.*', '周', 'k', 's', 'İ', 'é', 'a', 'not found']) {
        const expected = await c.find({ lifecycleStatus: 'ready', title: { $regex: escapeRegex(query), $options: 'i' } }).sort({ _id: 1 }).toArray();
        const actual = await c.find({ $and: [{ lifecycleStatus: 'ready' }, catalogSearchFilter('title', query, true)] }).sort({ _id: 1 }).toArray();
        assert.deepEqual(actual.map(row => row._id), expected.map(row => row._id), query);
    }
});

test('rare substring lookup examines candidates rather than the entire indexed catalog', async () => {
    const c = getDb()!.collection('searchScale');
    await c.insertMany(Array.from({ length: 10_000 }, (_, index) => {
        const title = index >= 9980 ? `Zneedle ${index}` : `Synthetic ${index}`;
        return { title, lifecycleStatus: 'ready', ...catalogSearchProjection(title) };
    }));
    await c.createIndex({ title: 1, _id: 1 });
    await c.createIndex({ catalogSearchVersion: 1 });
    await c.createIndex({ catalogSearchGrams: 1, catalogSearchVersion: 1 });
    const plan = await c.find({ lifecycleStatus: 'ready', ...catalogSearchFilter('title', 'needle', true) })
        .sort({ title: 1, _id: 1 }).limit(20).maxTimeMS(5_000).explain('executionStats');
    assert.equal(plan.executionStats.nReturned, 20);
    assert.ok(plan.executionStats.totalKeysExamined < 200, JSON.stringify(plan.executionStats));
    assert.ok(plan.executionStats.totalDocsExamined < 200);
});

test('backfill is read-only by default, bounded, source-fenced and retryable', async () => {
    const db = getDb()!; const c = db.collection('albums');
    await c.deleteMany({});
    const first = new ObjectId(); const second = new ObjectId();
    await c.insertMany([{ _id: first, title: 'Before' }, { _id: second, title: 'Second' }]);
    const options = { collection: 'albums' as const, limit: 1, apply: false };
    const dry = await backfillCatalogSearch(db, options);
    assert.equal(dry.scanned, 1); assert.equal(dry.nextCursor, first.toHexString());
    assert.equal((await c.findOne({ _id: first }))!.catalogSearchVersion, undefined);
    await assert.rejects(backfillCatalogSearch(db, { ...options, apply: true }, async () => { throw new Error('Injected write interruption'); }));
    assert.equal((await c.findOne({ _id: first }))!.catalogSearchVersion, undefined);
    const race = await backfillCatalogSearch(db, { ...options, apply: true }, async () => {
        await Album.updateById(first.toHexString(), { title: 'Winner' });
    });
    assert.equal(race.changedSources, 1);
    assert.deepEqual((await c.findOne({ _id: first }))!.catalogSearchGrams, catalogSearchProjection('Winner').catalogSearchGrams);
    const next = await backfillCatalogSearch(db, { ...options, apply: true, after: dry.nextCursor! });
    assert.equal(next.updated, 1); assert.equal(next.nextCursor, null);
    assert.equal((await backfillCatalogSearch(db, { ...options, apply: true })).updated, 1);
    await assert.rejects(backfillCatalogSearch(db, { ...options, limit: 501 }));
});

test('every catalog model maintains candidate metadata on insert and rename, including cover CAS paths', async () => {
    const db = getDb()!; const userId = new ObjectId();
    await db.collection('users').insertOne({ _id: userId, email: 'synthetic-search@example.test' });
    const owner = userId.toHexString();
    const album = await new Album('Initial', '', [] as unknown as [string], new SimpleDate(), owner).save();
    const artist = await new Artist('Initial', new SimpleDate(), '', '', [] as unknown as [string], owner).save();
    const org = await new Organization('Initial', 'label', '', owner).save();
    const track = await new AudioTrack('Initial', [] as unknown as [string], [] as unknown as [string], '', new SimpleDate(), '', new AudioFormat('mp3'), '', owner).save();
    const items = [['albums', album!.insertedId], ['artists', artist!.insertedId], ['organizations', org.insertedId], ['audioTracks', track.insertedId]] as const;
    for (const [name, id] of items) assert.equal((await db.collection(name).findOne({ _id: id }))!.catalogSearchVersion, 1);
    await Album.updateCoverArtById(String(album!.insertedId), null, { title: 'Renamed' });
    await Artist.updateCoverArtById(String(artist!.insertedId), null, { name: 'Renamed' });
    await Organization.updateById(String(org.insertedId), { name: 'Renamed' });
    await AudioTrack.updateById(String(track.insertedId), { title: 'Renamed' });
    for (const [name, id] of items) {
        const stored = await db.collection(name).findOne({ _id: id });
        assert.deepEqual(stored!.catalogSearchGrams, catalogSearchProjection('Renamed').catalogSearchGrams);
    }
    const previous = process.env.CATALOG_SEARCH_INDEX_ENABLED;
    try {
        process.env.CATALOG_SEARCH_INDEX_ENABLED = 'false';
        const legacy = [await searchListenerContent('Renamed', 20), await searchPublicCatalog('Renamed', 20)];
        process.env.CATALOG_SEARCH_INDEX_ENABLED = 'true';
        const indexed = [await searchListenerContent('Renamed', 20), await searchPublicCatalog('Renamed', 20)];
        assert.deepEqual(indexed, legacy);
        assert.doesNotMatch(JSON.stringify(indexed), /catalogSearch/);
    } finally {
        if (previous === undefined) delete process.env.CATALOG_SEARCH_INDEX_ENABLED;
        else process.env.CATALOG_SEARCH_INDEX_ENABLED = previous;
    }
});
