import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import {
    addCatalogCredit,
    addSoundtrackCredit,
    ensureAlbumPrimaryArtistCredit,
    removeAlbumPrimaryArtistCredit,
    removeCatalogCredit,
    reorderCatalogCredits,
    replaceCatalogCredits
} from '../src/services/catalogCreditService';
import { reconcileContentReferences } from '../src/services/contentReferenceReconciliationService';
import { getListenerAlbum, getListenerOrganization } from '../src/services/listenerContentService';
import { deleteUnreferencedOrganization } from '../src/services/organizationLifecycleService';
import {
    getPublicOrganization,
    searchPublicCatalog
} from '../src/services/publicCatalogService';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-catalog-credit-test');
});

beforeEach(async () => {
    await Promise.all(['albums', 'audioTracks', 'artists', 'organizations']
        .map((collection) => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

const seed = async () => {
    const artistId = new ObjectId();
    const featuredId = new ObjectId();
    const organizationId = new ObjectId();
    const albumId = new ObjectId();
    const trackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertMany([
            { _id: artistId, name: 'Primary', albumIds: [], lifecycleStatus: 'ready', referenceRevision: 0 },
            { _id: featuredId, name: 'Featured', albumIds: [], lifecycleStatus: 'ready', referenceRevision: 0 }
        ]),
        getDb()!.collection('organizations').insertOne({
            _id: organizationId,
            name: 'Release House',
            organizationType: 'label',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('albums').insertOne({
            _id: albumId,
            title: 'Credited Album',
            lifecycleStatus: 'ready',
            referenceRevision: 0
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: trackId,
            title: 'Credited Track',
            artistIds: [],
            uploadStatus: 'ready',
            contentReferenceRevision: 0
        })
    ]);
    return { artistId, featuredId, organizationId, albumId, trackId };
};

test('Album Credits atomically maintain primary legacy membership and Organization attribution', async () => {
    const { artistId, featuredId, organizationId, albumId } = await seed();
    const result = await replaceCatalogCredits('album', albumId.toHexString(), [
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary' },
        { creditId: 'credit_featured', subjectType: 'artist', subjectId: featuredId.toHexString(), role: 'featured' },
        { creditId: 'credit_label', subjectType: 'organization', subjectId: organizationId.toHexString(), role: 'label' }
    ], 'documented');
    assert.equal(result.creditRevision, 1);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        [albumId.toHexString()]
    );
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: featuredId }))!.albumIds,
        []
    );

    await replaceCatalogCredits('album', albumId.toHexString(), [
        { creditId: 'credit_new_primary', subjectType: 'artist', subjectId: featuredId.toHexString(), role: 'primary' }
    ], 'documented', 1);
    assert.deepEqual((await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds, []);
    assert.deepEqual((await getDb()!.collection('artists').findOne({ _id: featuredId }))!.albumIds, [albumId.toHexString()]);
});

test('Soundtrack Credit add, reorder, and remove keep artistIds as a server projection', async () => {
    const { artistId, featuredId, trackId } = await seed();
    await addCatalogCredit('audioTrack', trackId.toHexString(), {
        creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary'
    });
    const added = await addCatalogCredit('audioTrack', trackId.toHexString(), {
        creditId: 'credit_featured', subjectType: 'artist', subjectId: featuredId.toHexString(), role: 'featured'
    }, 1);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        [artistId.toHexString(), featuredId.toHexString()]
    );

    await reorderCatalogCredits('audioTrack', trackId.toHexString(), [
        'credit_featured', 'credit_primary'
    ], added.creditRevision);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        [featuredId.toHexString(), artistId.toHexString()]
    );
    await removeCatalogCredit('audioTrack', trackId.toHexString(), 'credit_primary', 'unknown', 3);
    assert.deepEqual(
        (await getDb()!.collection('audioTracks').findOne({ _id: trackId }))!.artistIds,
        [featuredId.toHexString()]
    );
});

test('explicit Soundtrack primary promotion updates the Track and Album in one transaction', async () => {
    const { artistId, albumId, trackId } = await seed();
    await getDb()!.collection('audioTracks').updateOne(
        { _id: trackId },
        { $set: { albumId: albumId.toHexString() } }
    );
    await addSoundtrackCredit(trackId.toHexString(), {
        creditId: 'promoted_track_primary',
        subjectType: 'artist',
        subjectId: artistId.toHexString(),
        role: 'primary'
    }, true);
    const track = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    const album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.deepEqual(track!.credits.map((credit: any) => credit.role), ['primary']);
    assert.deepEqual(album!.credits.map((credit: any) => credit.role), ['primary']);
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds,
        [albumId.toHexString()]
    );
});

test('invalid or unavailable Album promotion leaves the Soundtrack unchanged', async () => {
    const { artistId, albumId, trackId } = await seed();
    await getDb()!.collection('audioTracks').updateOne(
        { _id: trackId },
        { $set: { albumId: albumId.toHexString() } }
    );
    await assert.rejects(
        addSoundtrackCredit(trackId.toHexString(), {
            creditId: 'featured_cannot_promote',
            subjectType: 'artist',
            subjectId: artistId.toHexString(),
            role: 'featured'
        }, true),
        (error: any) => error?.code === 'catalog_credit_invalid'
    );
    await getDb()!.collection('albums').updateOne(
        { _id: albumId },
        { $set: { lifecycleStatus: 'deleting' } }
    );
    await assert.rejects(addSoundtrackCredit(trackId.toHexString(), {
        creditId: 'primary_with_deleting_album',
        subjectType: 'artist',
        subjectId: artistId.toHexString(),
        role: 'primary'
    }, true));
    const track = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    assert.equal(track!.credits, undefined);
    assert.deepEqual(track!.artistIds, []);
});

test('deleting subjects and stale revisions abort without partial projection writes', async () => {
    const { artistId, albumId } = await seed();
    await getDb()!.collection('artists').updateOne(
        { _id: artistId },
        { $set: { lifecycleStatus: 'deleting' } }
    );
    await assert.rejects(
        replaceCatalogCredits('album', albumId.toHexString(), [
            { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary' }
        ], 'documented'),
        (error: any) => error?.code === 'artist_reference_unavailable'
    );
    const album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.equal(album!.credits, undefined);

    await getDb()!.collection('artists').updateOne(
        { _id: artistId },
        { $set: { lifecycleStatus: 'ready' } }
    );
    await replaceCatalogCredits('album', albumId.toHexString(), [
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary' }
    ], 'documented');
    await assert.rejects(
        replaceCatalogCredits('album', albumId.toHexString(), [
            { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary' }
        ], 'documented', 0),
        (error: any) => error?.code === 'catalog_credit_conflict'
    );
});

test('explicit unknown attribution allows no synthetic subject', async () => {
    const { albumId } = await seed();
    const result = await replaceCatalogCredits('album', albumId.toHexString(), [], 'unknown');
    assert.equal(result.attributionStatus, 'unknown');
    assert.deepEqual(result.credits, []);
});

test('first shadow write preserves unmigrated Album and Soundtrack relationships', async () => {
    const { artistId, featuredId, albumId, trackId } = await seed();
    await getDb()!.collection('artists').updateOne(
        { _id: artistId },
        { $set: { albumIds: [albumId.toHexString()] } }
    );
    await getDb()!.collection('audioTracks').updateOne(
        { _id: trackId },
        { $set: { artistIds: [artistId.toHexString()] } }
    );

    await ensureAlbumPrimaryArtistCredit(albumId.toHexString(), featuredId.toHexString());
    const album = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.deepEqual(album!.credits.map((credit: any) => [credit.subjectId, credit.role]), [
        [artistId.toHexString(), 'primary'],
        [featuredId.toHexString(), 'primary']
    ]);
    assert.deepEqual((await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds, [albumId.toHexString()]);

    await removeAlbumPrimaryArtistCredit(albumId.toHexString(), artistId.toHexString(), 1);
    const afterRemoval = await getDb()!.collection('albums').findOne({ _id: albumId });
    assert.deepEqual(afterRemoval!.credits.map((credit: any) => [credit.subjectId, credit.role]), [
        [featuredId.toHexString(), 'primary']
    ]);
    assert.deepEqual((await getDb()!.collection('artists').findOne({ _id: artistId }))!.albumIds, []);

    await addCatalogCredit('audioTrack', trackId.toHexString(), {
        creditId: 'credit_featured',
        subjectType: 'artist',
        subjectId: featuredId.toHexString(),
        role: 'featured'
    });
    const track = await getDb()!.collection('audioTracks').findOne({ _id: trackId });
    assert.deepEqual(track!.credits.map((credit: any) => [credit.subjectId, credit.role]), [
        [artistId.toHexString(), 'legacyUnspecified'],
        [featuredId.toHexString(), 'featured']
    ]);
    const repeated = await addCatalogCredit('audioTrack', trackId.toHexString(), {
        creditId: 'different_credit_id',
        subjectType: 'artist',
        subjectId: featuredId.toHexString(),
        role: 'featured'
    }, 1);
    assert.equal(repeated.creditRevision, 1);
});

test('reconciliation detects Credit projection drift and clears after a safe replacement', async () => {
    const { artistId, albumId } = await seed();
    const credits = [
        { creditId: 'credit_primary', subjectType: 'artist', subjectId: artistId.toHexString(), role: 'primary' }
    ];
    await replaceCatalogCredits('album', albumId.toHexString(), credits, 'documented');
    assert.deepEqual((await reconcileContentReferences()).catalogCreditFindings, []);

    await getDb()!.collection('artists').updateOne(
        { _id: artistId },
        { $set: { albumIds: [] } }
    );
    assert.deepEqual((await reconcileContentReferences()).catalogCreditFindings, [{
        ownerType: 'album',
        ownerId: albumId.toHexString(),
        reason: 'legacyProjectionMismatch'
    }]);

    await replaceCatalogCredits('album', albumId.toHexString(), credits, 'documented', 1);
    assert.deepEqual((await reconcileContentReferences()).catalogCreditFindings, []);
});

test('listener Album DTO resolves Organization-only attribution without inventing an Artist', async () => {
    const { organizationId, albumId } = await seed();
    await replaceCatalogCredits('album', albumId.toHexString(), [{
        creditId: 'credit_label',
        subjectType: 'organization',
        subjectId: organizationId.toHexString(),
        role: 'label'
    }], 'documented');
    const listener = await getListenerAlbum(albumId.toHexString());
    assert.deepEqual(listener?.album.artistNames, []);
    assert.equal(listener?.album.displayByline, 'Release House');
    assert.deepEqual(listener?.album.credits, [{
        subjectType: 'organization',
        subjectId: organizationId.toHexString(),
        name: 'Release House',
        role: 'label',
        order: 0
    }]);
});

test('Organization releases resolve publicly and deletion is blocked until Credits are removed', async () => {
    const { organizationId, albumId } = await seed();
    await replaceCatalogCredits('album', albumId.toHexString(), [{
        creditId: 'credit_label',
        subjectType: 'organization',
        subjectId: organizationId.toHexString(),
        role: 'label'
    }], 'documented');
    const detail = await getListenerOrganization(organizationId.toHexString());
    assert.equal(detail?.organization.name, 'Release House');
    assert.deepEqual(detail?.releases.map((album) => album.id), [albumId.toHexString()]);
    const legacyClientDetail = await getPublicOrganization(organizationId.toHexString());
    assert.equal(legacyClientDetail?.organization.name, 'Release House');
    assert.deepEqual(
        legacyClientDetail?.releases.map((album) => album._id),
        [albumId.toHexString()]
    );
    const search = await searchPublicCatalog('Release House', 20);
    assert.deepEqual(search.organizations.map((organization) => organization._id), [
        organizationId.toHexString()
    ]);
    await assert.rejects(
        deleteUnreferencedOrganization(organizationId.toHexString()),
        (error: any) => error?.code === 'organization_referenced'
    );
    assert.equal(
        (await getDb()!.collection('organizations').findOne({ _id: organizationId }))?.lifecycleStatus,
        'ready'
    );
    await replaceCatalogCredits('album', albumId.toHexString(), [], 'unknown', 1);
    await deleteUnreferencedOrganization(organizationId.toHexString());
    assert.equal(await getDb()!.collection('organizations').findOne({ _id: organizationId }), null);
});
