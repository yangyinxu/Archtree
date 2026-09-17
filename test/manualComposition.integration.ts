import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { ManualCompositionConflictError } from '../src/services/manualCompositionService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const actor = new ObjectId();
const albums = [new ObjectId(), new ObjectId(), new ObjectId()];
const item = (index: number) => ({ contentType: 'album' as const, contentId: albums[index].toHexString(), order: index });
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { resolve, promise };
};
before(async () => { harness = await startMongoReplicaSet('archtree-manual-composition-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => {
    await Promise.all(['users', 'albums', 'carousels', 'contentCollections'].map(name => getDb()!.collection(name).deleteMany({})));
    await getDb()!.collection('users').insertOne({ _id: actor });
    await getDb()!.collection('albums').insertMany(albums.map(_id => ({ _id, lifecycleStatus: 'ready' })));
});
const seed = async (name: string, items: ReturnType<typeof item>[] = []) => {
    const _id = new ObjectId();
    await getDb()!.collection(name).insertOne({ _id, mode: 'manual', contentType: 'album', items });
    return _id.toHexString();
};
const stored = async (name: string, id: string) => (await getDb()!.collection(name).findOne({ _id: new ObjectId(id) }))!.items;

for (const [name, model] of [['carousels', Carousel], ['contentCollections', ContentCollection]] as const) {
    test(`${name}: concurrent appends both survive transaction retry`, async () => {
        const id = await seed(name);
        const bothRead = deferred();
        let reads = 0;
        const afterRead = async () => { if (++reads === 2) bothRead.resolve(); await bothRead.promise; };
        const results = await Promise.all([0, 1].map(index => model.addItem(id, item(index), actor.toHexString(), undefined, { afterRead })));
        assert.ok(results.every(Boolean));
        const saved = await stored(name, id);
        assert.deepEqual(new Set(saved.map((entry: any) => entry.contentId)), new Set(albums.slice(0, 2).map(String)));
        assert.deepEqual(saved.map((entry: any) => entry.order), [0, 1]);
    });
    test(`${name}: stale index edits report conflict rather than replacing another edit`, async () => {
        const id = await seed(name, [item(0), item(1)]);
        const read = deferred(); const resume = deferred();
        const reorder = model.reorderItem(id, 0, 1, actor.toHexString(), { afterRead: async () => { read.resolve(); await resume.promise; } });
        const rejected = assert.rejects(reorder, ManualCompositionConflictError);
        await read.promise;
        await model.addItem(id, item(2), actor.toHexString());
        resume.resolve(); await rejected;
        assert.deepEqual((await stored(name, id)).map((entry: any) => entry.contentId), albums.map(String));
    });
    test(`${name}: concurrent additions enforce the 500 member limit`, async () => {
        const id = await seed(name, Array.from({ length: 499 }, () => item(0)));
        const bothRead = deferred(); let reads = 0;
        const afterRead = async () => { if (++reads === 2) bothRead.resolve(); await bothRead.promise; };
        const results = await Promise.all([1, 2].map(index => model.addItem(id, item(index), actor.toHexString(), undefined, { afterRead })));
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal((await stored(name, id)).length, 500);
    });
    test(`${name}: deletion while an append is paused cannot acknowledge a lost write`, async () => {
        const id = await seed(name);
        const read = deferred(); const resume = deferred();
        const append = model.addItem(id, item(0), actor.toHexString(), undefined, { afterRead: async () => { read.resolve(); await resume.promise; } });
        await read.promise;
        await getDb()!.collection(name).deleteOne({ _id: new ObjectId(id) });
        resume.resolve();
        assert.equal(await append, null);
        assert.equal(await getDb()!.collection(name).countDocuments({ _id: new ObjectId(id) }), 0);
    });
    test(`${name}: deleted accounts cannot commit catalog edits`, async () => {
        const id = await seed(name);
        const read = deferred(); const resume = deferred();
        const append = model.addItem(id, item(0), actor.toHexString(), undefined, { afterRead: async () => { read.resolve(); await resume.promise; } });
        const rejected = assert.rejects(append, /account/i);
        await read.promise;
        await getDb()!.collection('users').deleteOne({ _id: actor });
        resume.resolve(); await rejected;
        assert.deepEqual(await stored(name, id), []);
    });
    test(`${name}: a referenced Album becoming unavailable rejects the entire append`, async () => {
        const id = await seed(name);
        const read = deferred(); const resume = deferred();
        const append = model.addItem(id, item(0), actor.toHexString(), undefined, { afterRead: async () => { read.resolve(); await resume.promise; } });
        const rejected = assert.rejects(append, /album/i);
        await read.promise;
        await getDb()!.collection('albums').updateOne({ _id: albums[0] }, { $set: { lifecycleStatus: 'deleting' } });
        resume.resolve(); await rejected;
        assert.deepEqual(await stored(name, id), []);
    });
}

for (const batch of [false, true]) {
    test(`Carousel ${batch ? 'batch' : 'single'} moves roll back both sides on failure`, async () => {
        const source = await seed('carousels', [item(0), item(1)]);
        const target = await seed('carousels', [item(2)]);
        const hooks = { afterWrites: async () => { throw new Error('injected failure after both writes'); } };
        await assert.rejects(batch
            ? Carousel.moveItemsBetweenCarousels(source, target, [0, 1], actor.toHexString(), hooks)
            : Carousel.moveItemBetweenCarousels(source, target, 0, 0, actor.toHexString(), hooks), /injected/);
        assert.deepEqual((await stored('carousels', source)).map((entry: any) => entry.contentId), albums.slice(0, 2).map(String));
        assert.deepEqual((await stored('carousels', target)).map((entry: any) => entry.contentId), [String(albums[2])]);
        assert.equal(await getDb()!.collection('albums').countDocuments({ referenceRevision: { $exists: true } }), 0);
    });
    test(`Carousel ${batch ? 'batch' : 'single'} moves reject concurrent target changes without removing the source`, async () => {
        const source = await seed('carousels', [item(0)]);
        const target = await seed('carousels');
        const read = deferred(); const resume = deferred();
        const hooks = { afterRead: async () => { read.resolve(); await resume.promise; } };
        const moving = batch ? Carousel.moveItemsBetweenCarousels(source, target, [0], actor.toHexString(), hooks)
            : Carousel.moveItemBetweenCarousels(source, target, 0, 0, actor.toHexString(), hooks);
        const rejected = assert.rejects(moving, ManualCompositionConflictError);
        await read.promise;
        await Carousel.addItem(target, item(1), actor.toHexString());
        resume.resolve(); await rejected;
        assert.equal((await stored('carousels', source))[0].contentId, String(albums[0]));
        assert.equal((await stored('carousels', target))[0].contentId, String(albums[1]));
    });
}
