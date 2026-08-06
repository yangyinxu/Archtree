import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { Page } from '../src/models/page';
import {
    deleteCarouselAndPageReferences,
    deleteContentCollectionAndPageReferences,
    PageItemReferenceUnavailableError
} from '../src/services/pageReferenceLifecycleService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

before(async () => {
    harness = await startMongoReplicaSet('archtree-page-reference-lifecycle-test');
});

beforeEach(async () => {
    await Promise.all([
        'pages',
        'carousels',
        'contentCollections',
        'users'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

type TargetFixture = {
    label: string;
    collectionName: 'carousels' | 'contentCollections';
    insertTarget: (targetId: ObjectId) => Promise<unknown>;
    addReference: (
        targetId: string,
        actorId: string,
        hooks: {
            beforeReferenceFence?: () => Promise<void>;
            afterPageWrite?: () => Promise<void>;
        }
    ) => Promise<unknown>;
    deleteTarget: (
        targetId: string,
        actorId: string,
        hooks?: { afterTargetFence?: () => Promise<void> }
    ) => Promise<boolean>;
};

const targetFixtures: TargetFixture[] = [
    {
        label: 'Carousel',
        collectionName: 'carousels',
        insertTarget: (targetId) => getDb()!.collection('carousels').insertOne({
            _id: targetId,
            name: 'Race Carousel',
            mode: 'manual',
            items: [],
            referenceRevision: 0
        }),
        addReference: (targetId, actorId, hooks) =>
            Page.addCarouselItem('home', targetId, actorId, undefined, hooks),
        deleteTarget: deleteCarouselAndPageReferences
    },
    {
        label: 'ContentCollection',
        collectionName: 'contentCollections',
        insertTarget: (targetId) => getDb()!.collection('contentCollections').insertOne({
            _id: targetId,
            name: 'Race Grid',
            presentation: 'grid',
            mode: 'manual',
            contentType: 'album',
            items: [],
            referenceRevision: 0
        }),
        addReference: (targetId, actorId, hooks) =>
            Page.addCollectionItem('home', 'grid', targetId, actorId, undefined, hooks),
        deleteTarget: deleteContentCollectionAndPageReferences
    }
];

const seedRace = async (fixture: TargetFixture) => {
    const attachActorId = new ObjectId();
    const deleteActorId = new ObjectId();
    const targetId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertMany([
            { _id: attachActorId, email: `attach-${fixture.label}@example.test`, role: 'admin' },
            { _id: deleteActorId, email: `delete-${fixture.label}@example.test`, role: 'admin' }
        ]),
        fixture.insertTarget(targetId),
        getDb()!.collection('pages').insertOne({
            _id: new ObjectId(),
            slug: 'home',
            title: 'Home',
            items: [],
            createdBy: attachActorId.toHexString(),
            updatedBy: attachActorId.toHexString()
        })
    ]);
    return { attachActorId, deleteActorId, targetId };
};

for (const fixture of targetFixtures) {
    test(`${fixture.label} add-first commits before deletion, which then removes the Page reference`, async () => {
        const { attachActorId, deleteActorId, targetId } = await seedRace(fixture);
        const pageWritten = deferred();
        const releasePageWrite = deferred();
        const reference = fixture.addReference(
            targetId.toHexString(),
            attachActorId.toHexString(),
            {
                afterPageWrite: async () => {
                    pageWritten.resolve();
                    await releasePageWrite.promise;
                }
            }
        );
        await pageWritten.promise;

        const deletion = fixture.deleteTarget(
            targetId.toHexString(),
            deleteActorId.toHexString()
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        releasePageWrite.resolve();

        await reference;
        assert.equal(await deletion, true);
        assert.equal(
            await getDb()!.collection(fixture.collectionName).findOne({ _id: targetId }),
            null
        );
        assert.deepEqual(
            (await getDb()!.collection('pages').findOne({ slug: 'home' }))!.items,
            []
        );
    });

    test(`${fixture.label} deletion-first rejects a blocked Page attachment without a dangling reference`, async () => {
        const { attachActorId, deleteActorId, targetId } = await seedRace(fixture);
        const targetFenced = deferred();
        const releaseDeletion = deferred();
        const deletion = fixture.deleteTarget(
            targetId.toHexString(),
            deleteActorId.toHexString(),
            {
                afterTargetFence: async () => {
                    targetFenced.resolve();
                    await releaseDeletion.promise;
                }
            }
        );
        await targetFenced.promise;

        const referenceStarted = deferred();
        const reference = fixture.addReference(
            targetId.toHexString(),
            attachActorId.toHexString(),
            {
                beforeReferenceFence: async () => {
                    referenceStarted.resolve();
                }
            }
        ).then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error })
        );
        await referenceStarted.promise;
        releaseDeletion.resolve();

        assert.equal(await deletion, true);
        const rejected = await reference;
        assert.equal(rejected.value, undefined);
        assert.ok(rejected.error instanceof PageItemReferenceUnavailableError);
        assert.equal(
            await getDb()!.collection(fixture.collectionName).findOne({ _id: targetId }),
            null
        );
        assert.deepEqual(
            (await getDb()!.collection('pages').findOne({ slug: 'home' }))!.items,
            []
        );
    });
}

test('Page.save fences every exact target, canonicalizes IDs, and rejects missing or mismatched targets', async () => {
    const actorId = new ObjectId();
    const carouselId = new ObjectId();
    const gridId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: actorId,
            email: 'page-save@example.test',
            role: 'admin'
        }),
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            name: 'Saved Carousel',
            mode: 'manual',
            items: [],
            referenceRevision: 0
        }),
        getDb()!.collection('contentCollections').insertOne({
            _id: gridId,
            name: 'Saved Grid',
            presentation: 'grid',
            mode: 'manual',
            contentType: 'album',
            items: [],
            referenceRevision: 0
        })
    ]);

    await new Page('home', 'Home', [
        {
            itemType: 'carousel',
            carouselId: carouselId.toHexString().toUpperCase(),
            order: 9
        },
        {
            itemType: 'grid',
            collectionId: gridId.toHexString().toUpperCase(),
            order: 4
        }
    ], actorId.toHexString(), actorId.toHexString()).save();
    const saved: any = await getDb()!.collection('pages').findOne({ slug: 'home' });
    assert.deepEqual(saved.items, [
        { itemType: 'carousel', carouselId: carouselId.toHexString(), order: 0 },
        { itemType: 'grid', collectionId: gridId.toHexString(), order: 1 }
    ]);

    const missing = new Page('library', 'Library', [{
        itemType: 'carousel',
        carouselId: new ObjectId().toHexString(),
        order: 0
    }], actorId.toHexString(), actorId.toHexString());
    await assert.rejects(
        missing.save(),
        (error: any) => error?.code === 'page_item_reference_unavailable'
    );
    const mismatched = new Page('library', 'Library', [{
        itemType: 'list',
        collectionId: gridId.toHexString(),
        order: 0
    }], actorId.toHexString(), actorId.toHexString());
    await assert.rejects(
        mismatched.save(),
        (error: any) => error?.code === 'page_item_reference_unavailable'
    );
    assert.equal(await getDb()!.collection('pages').findOne({ slug: 'library' }), null);
});

test('target deletion removes legacy ID variants and reindexes every retained Page item', async () => {
    const actorId = new ObjectId();
    const carouselId = new ObjectId();
    const retainedCollectionId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: actorId,
            email: 'legacy-page-reference@example.test',
            role: 'admin'
        }),
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            mode: 'manual',
            items: []
        }),
        getDb()!.collection('contentCollections').insertOne({
            _id: retainedCollectionId,
            presentation: 'grid',
            mode: 'manual',
            items: []
        }),
        getDb()!.collection('pages').insertOne({
            _id: new ObjectId(),
            slug: 'home',
            items: [
                {
                    itemType: 'carousel',
                    carouselId: carouselId.toHexString().toUpperCase(),
                    order: 8
                },
                {
                    itemType: 'grid',
                    collectionId: retainedCollectionId.toHexString(),
                    order: 12
                },
                { itemType: 'carousel', carouselId, order: 21 }
            ]
        })
    ]);

    assert.equal(
        await deleteCarouselAndPageReferences(
            carouselId.toHexString(),
            actorId.toHexString()
        ),
        true
    );
    assert.deepEqual(
        (await getDb()!.collection('pages').findOne({ slug: 'home' }))!.items,
        [{
            itemType: 'grid',
            collectionId: retainedCollectionId.toHexString(),
            order: 0
        }]
    );
});
