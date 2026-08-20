import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { SimpleDate } from '../src/models/simpleDate';
import {
    resumeArtistReleaseWorkflow,
    runArtistReleaseWorkflow
} from '../src/services/artistReleaseWorkflowService';
import { reconcileContentReferences } from '../src/services/contentReferenceReconciliationService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let adminId: ObjectId;

before(async () => {
    harness = await startMongoReplicaSet('archtree-artist-release-workflow-test');
});

beforeEach(async () => {
    await Promise.all([
        'users',
        'artists',
        'albums',
        'carousels',
        'pages',
        'contentWorkflowOperations',
        'imageAssets'
    ].map((collection) => getDb()!.collection(collection).deleteMany({})));
    adminId = new ObjectId();
    await getDb()!.collection('users').insertOne({ _id: adminId, role: 'admin' });
});

after(async () => {
    await harness?.stop();
});

const input = (token: string) => ({
    idempotencyToken: token,
    artistMode: 'new' as const,
    artistName: 'Guided Artist',
    artistBio: 'Created from one reviewed setup.',
    artistBirthDate: new SimpleDate(2000, 1, 2),
    albumTitle: 'Guided Album',
    albumReleaseDate: new SimpleDate(2026, 8, 8),
    createCarousel: true,
    carouselName: 'Guided Artist Albums',
    carouselSort: 'releaseDateDesc' as const,
    carouselLimit: 20,
    pageSlug: 'home' as const,
    pagePosition: 0
});

test('guided setup creates and links one release and is idempotent on resubmission', async () => {
    await getDb()!.collection('pages').insertOne({
        slug: 'home',
        title: 'Home',
        items: [],
        createdBy: adminId.toHexString(),
        updatedBy: adminId.toHexString()
    });
    const request = input('release_setup_token_0001');
    const first = await runArtistReleaseWorkflow(adminId.toHexString(), request);
    const repeated = await runArtistReleaseWorkflow(adminId.toHexString(), request);

    assert.equal(first.status, 'complete');
    assert.equal(repeated.operationId, first.operationId);
    assert.equal(repeated.artistId, first.artistId);
    assert.equal(repeated.albumId, first.albumId);
    assert.equal(repeated.carouselId, first.carouselId);
    assert.equal(await getDb()!.collection('artists').countDocuments(), 1);
    assert.equal(await getDb()!.collection('albums').countDocuments(), 1);
    assert.equal(await getDb()!.collection('carousels').countDocuments(), 1);
    const artist = await getDb()!.collection('artists').findOne({
        _id: ObjectId.createFromHexString(first.artistId!)
    });
    assert.deepEqual(artist!.albumIds, [first.albumId]);
    const carousel = await getDb()!.collection('carousels').findOne({
        _id: ObjectId.createFromHexString(first.carouselId!)
    });
    assert.equal(carousel!.mode, 'artist');
    assert.deepEqual(carousel!.items, []);
    assert.equal(carousel!.artistConfig.artistId, first.artistId);
    assert.equal(carousel!.artistConfig.contentType, 'album');
    const page = await getDb()!.collection('pages').findOne({ slug: 'home' });
    assert.deepEqual(page!.items, [{
        itemType: 'carousel',
        carouselId: first.carouselId,
        order: 0
    }]);
});

test('a failed optional Page step retains content and resumes without duplicates', async () => {
    const request = input('release_setup_token_0002');
    await assert.rejects(
        runArtistReleaseWorkflow(adminId.toHexString(), request),
        (error: any) => error?.workflowNeedsAttention === true
            && typeof error?.operationId === 'string'
    );

    assert.equal(await getDb()!.collection('artists').countDocuments(), 1);
    assert.equal(await getDb()!.collection('albums').countDocuments(), 1);
    assert.equal(await getDb()!.collection('carousels').countDocuments(), 1);
    const failedOperation: any = await getDb()!.collection('contentWorkflowOperations').findOne({});
    assert.equal(failedOperation.status, 'needsAttention');
    assert.equal(failedOperation.steps.page.status, 'failed');
    assert.deepEqual(
        (await reconcileContentReferences()).artistReleaseWorkflowFindings.map((finding: any) => finding.reason),
        ['incomplete']
    );

    await getDb()!.collection('pages').insertOne({
        slug: 'home',
        title: 'Home',
        items: [],
        createdBy: adminId.toHexString(),
        updatedBy: adminId.toHexString()
    });
    const resumed = await resumeArtistReleaseWorkflow(
        adminId.toHexString(),
        String(failedOperation._id)
    );
    assert.equal(resumed.status, 'complete');
    assert.equal(await getDb()!.collection('artists').countDocuments(), 1);
    assert.equal(await getDb()!.collection('albums').countDocuments(), 1);
    assert.equal(await getDb()!.collection('carousels').countDocuments(), 1);
    assert.equal((await getDb()!.collection('pages').findOne({ slug: 'home' }))!.items.length, 1);
    assert.deepEqual((await reconcileContentReferences()).artistReleaseWorkflowFindings, []);
});

test('one token cannot be reused with different release intent', async () => {
    const request = { ...input('release_setup_token_0003'), createCarousel: false, pageSlug: undefined };
    await runArtistReleaseWorkflow(adminId.toHexString(), request);
    await assert.rejects(
        runArtistReleaseWorkflow(adminId.toHexString(), { ...request, albumTitle: 'Different Album' }),
        (error: any) => error?.code === 'artist_release_token_reused'
    );
    assert.equal(await getDb()!.collection('albums').countDocuments(), 1);
});
