import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { migrateCatalogCredits } from '../src/services/catalogCreditMigrationService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-catalog-credit-migration-test');
});

beforeEach(async () => {
    await Promise.all(['albums', 'audioTracks', 'artists', 'organizations']
        .map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('migration is dry-run-first, role-safe, idempotent, and explicitly handles unattributed rows', async () => {
    const artistId = new ObjectId();
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    const unknownAlbumId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: artistId,
            name: 'Legacy Artist',
            albumIds: [albumId.toHexString()],
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('albums').insertMany([
            { _id: albumId, title: 'Legacy Album', lifecycleStatus: 'ready', referenceRevision: 0 },
            { _id: unknownAlbumId, title: 'Undocumented', lifecycleStatus: 'ready', referenceRevision: 0 }
        ]),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Legacy Track',
            artistIds: [artistId.toHexString()],
            uploadStatus: 'ready'
        })
    ]);

    const dryRun = await migrateCatalogCredits({ limit: 20 });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.outcomes.filter((outcome) => outcome.action === 'wouldMigrate').length, 2);
    assert.equal(dryRun.findings.some((finding) =>
        finding.ownerId === unknownAlbumId.toHexString()
        && finding.reason === 'unattributedRequiresDecision'), true);
    assert.equal((await getDb()!.collection('albums').findOne({ _id: albumId }))!.credits, undefined);

    const applied = await migrateCatalogCredits({ apply: true, limit: 20, markUnattributedUnknown: true });
    assert.equal(applied.findings.length, 0);
    const album = await getDb()!.collection('albums').findOne({ _id: albumId });
    const track = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    assert.equal(album!.credits[0].role, 'primary');
    assert.equal(track!.credits[0].role, 'legacyUnspecified');
    assert.equal((await getDb()!.collection('albums').findOne({ _id: unknownAlbumId }))!.attributionStatus, 'unknown');

    const repeated = await migrateCatalogCredits({ apply: true, limit: 20, markUnattributedUnknown: true });
    assert.equal(repeated.outcomes.every((outcome) => outcome.action === 'alreadyMigrated'), true);
});
