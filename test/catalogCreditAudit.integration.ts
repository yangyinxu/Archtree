import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../src/infrastructure/database';
import { reconcileContentReferences } from '../src/services/contentReferenceReconciliationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const originalLimit = process.env.MAX_RECONCILIATION_OBJECTS;
const originalReferenceLimit = process.env.MAX_RECONCILIATION_REFERENCES;
const collections = ['albums', 'audioTracks', 'artists', 'organizations', 'catalogDeletionOperations'];
before(async () => { harness = await startMongoReplicaSet('archtree-credit-audit-test'); });
beforeEach(async () => {
    process.env.MAX_RECONCILIATION_OBJECTS = '1';
    process.env.MAX_RECONCILIATION_REFERENCES = '100';
    await Promise.all(collections.map(name => getDb()!.collection(name).deleteMany({})));
});
after(async () => {
    if (originalLimit === undefined) delete process.env.MAX_RECONCILIATION_OBJECTS;
    else process.env.MAX_RECONCILIATION_OBJECTS = originalLimit;
    if (originalReferenceLimit === undefined) delete process.env.MAX_RECONCILIATION_REFERENCES;
    else process.env.MAX_RECONCILIATION_REFERENCES = originalReferenceLimit;
    await harness?.stop();
});

const id = (suffix: number) => new ObjectId(`abcdef01234567890123${String(suffix).padStart(4, '0')}`);
const credit = (subjectType: 'artist' | 'organization', subjectId: ObjectId, order = 0) => ({
    creditId: `synthetic_credit_${order}`, subjectType, subjectId: subjectId.toHexString(),
    role: subjectType === 'artist' ? 'primary' : 'label', order
});
const unknownAlbum = (albumId: ObjectId) => ({
    _id: albumId, credits: [], attributionStatus: 'unknown', lifecycleStatus: 'ready'
});
const outsideArtists = async (target: ObjectId) => {
    await getDb()!.collection('artists').insertMany([
        { _id: id(1), albumIds: [], lifecycleStatus: 'ready' },
        { _id: target, albumIds: [], lifecycleStatus: 'ready' }
    ]);
};

/** Captures synthetic fixtures only; reconciliation must never mutate them. */
const fixtureSnapshot = async () => JSON.stringify(await Promise.all(collections.map(name =>
    getDb()!.collection(name).find().sort({ _id: 1 }).toArray()
)));
const deletionReceipts = () => getDb()!.collection<{
    _id: string; ownerType: string; ownerId: string; status: string; leaseUntil: Date;
}>('catalogDeletionOperations');

test('a one-record source window verifies existing Credit subjects and mixed-case legacy memberships beyond it', async () => {
    const artist = id(3), organization = id(4), album = id(10), track = id(20);
    await outsideArtists(artist);
    const mixedCaseAlbum = album.toHexString().split('').map((value, index) => index % 2 ? value.toUpperCase() : value).join('');
    await Promise.all([
        getDb()!.collection('artists').updateOne({ _id: artist }, { $set: { albumIds: [mixedCaseAlbum] } }),
        getDb()!.collection('organizations').insertMany([
            { _id: id(2), lifecycleStatus: 'ready' }, { _id: organization, lifecycleStatus: 'ready' }
        ]),
        getDb()!.collection('albums').insertOne({ _id: album, credits: [credit('artist', artist), credit('organization', organization, 1)], attributionStatus: 'documented' }),
        getDb()!.collection('audioTracks').insertOne({ _id: track, artistIds: [artist.toHexString()], credits: [credit('artist', artist), credit('organization', organization, 1)], attributionStatus: 'documented' })
    ]);
    const before = await fixtureSnapshot();
    const report = await reconcileContentReferences();
    assert.equal(report.readOnly, true);
    assert.equal(report.truncated, true);
    assert.deepEqual(report.catalogCreditFindings, []);
    assert.deepEqual(report.catalogCreditUnverified, []);
    assert.equal(await fixtureSnapshot(), before);
});

test('exact lookup still reports actually missing and lifecycle-unavailable subjects', async () => {
    const missing = id(9), unavailable = id(8);
    await outsideArtists(id(3));
    await getDb()!.collection('organizations').insertMany([
        { _id: id(1), lifecycleStatus: 'ready' }, { _id: unavailable, lifecycleStatus: 'deleting' }
    ]);
    await getDb()!.collection('audioTracks').insertOne({
        _id: id(20), artistIds: [missing.toHexString()],
        credits: [credit('artist', missing), credit('organization', unavailable, 1)], attributionStatus: 'documented'
    });
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings.map(finding => [finding.reason, finding.subjectId]), [
        ['missingSubject', missing.toHexString()], ['unavailableSubject', unavailable.toHexString()]
    ]);
    assert.deepEqual(report.catalogCreditUnverified, []);
});

test('an exhausted embedded budget emits unverified evidence instead of a missing subject', async () => {
    process.env.MAX_RECONCILIATION_REFERENCES = '1';
    const artist = id(3);
    await outsideArtists(artist);
    await getDb()!.collection('audioTracks').insertOne({
        _id: id(20), artistIds: [artist.toHexString()], credits: [credit('artist', artist)], attributionStatus: 'documented'
    });
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings, []);
    assert.deepEqual(report.catalogCreditUnverified, [{
        ownerType: 'audioTrack', ownerId: id(20).toHexString(),
        reason: 'subjectLookupBudgetExceeded', subjectId: artist.toHexString()
    }]);
    assert.equal(report.truncated, true);
});

test('subject target truncation verifies the admitted lookup and leaves the other target unverified', async () => {
    process.env.MAX_RECONCILIATION_REFERENCES = '1';
    const checked = id(3), unverified = id(4);
    await getDb()!.collection('organizations').insertMany([id(1), checked, unverified].map(_id => ({ _id, lifecycleStatus: 'ready' })));
    await getDb()!.collection('audioTracks').insertOne({
        _id: id(20), artistIds: [], credits: [credit('organization', checked), credit('organization', unverified, 1)], attributionStatus: 'documented'
    });
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings, []);
    assert.deepEqual(report.catalogCreditUnverified.map(finding => finding.subjectId), [unverified.toHexString()]);
    assert.equal(report.truncated, true);
});

test('a truncated projection row set never establishes a legacy projection mismatch', async () => {
    process.env.MAX_RECONCILIATION_REFERENCES = '2';
    const album = id(10);
    await getDb()!.collection('albums').insertOne(unknownAlbum(album));
    await getDb()!.collection('artists').insertMany([
        { _id: id(1), albumIds: [] },
        { _id: id(2), albumIds: [album.toHexString()] },
        { _id: id(3), albumIds: [album] }
    ]);
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings, []);
    assert.deepEqual(report.catalogCreditUnverified, [{
        ownerType: 'album', ownerId: album.toHexString(), reason: 'legacyProjectionLookupBudgetExceeded'
    }]);
    assert.equal(report.truncated, true);
});

test('projection target truncation does not discard another Album that was completely checked', async () => {
    process.env.MAX_RECONCILIATION_OBJECTS = '2';
    process.env.MAX_RECONCILIATION_REFERENCES = '1';
    await getDb()!.collection('albums').insertMany([unknownAlbum(id(10)), unknownAlbum(id(11))]);
    await getDb()!.collection('artists').insertMany([id(1), id(2), id(3)].map(_id => ({ _id, albumIds: [] })));
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings, []);
    assert.deepEqual(report.catalogCreditUnverified.map(finding => finding.ownerId), [id(11).toHexString()]);
    assert.equal(report.truncated, true);
});

test('a complete supplemental projection still identifies actual drift', async () => {
    const album = id(10);
    await getDb()!.collection('albums').insertOne(unknownAlbum(album));
    await getDb()!.collection('artists').insertMany([
        { _id: id(1), albumIds: [] }, { _id: id(2), albumIds: [album] }
    ]);
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings.map(finding => finding.reason), ['legacyProjectionMismatch']);
    assert.deepEqual(report.catalogCreditUnverified, []);
});

test('complete source windows establish missing subjects without marking a complete report truncated', async () => {
    await getDb()!.collection('audioTracks').insertOne({
        _id: id(20), artistIds: [], credits: [credit('organization', id(8))], attributionStatus: 'documented'
    });
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogCreditFindings.map(finding => finding.reason), ['missingSubject']);
    assert.deepEqual(report.catalogCreditUnverified, []);
    assert.equal(report.truncated, false);
});

test('unverified evidence and confirmed defects share the report-wide findings limit', async () => {
    process.env.MAX_RECONCILIATION_REFERENCES = '1';
    const artist = id(3);
    await outsideArtists(artist);
    await getDb()!.collection('audioTracks').insertOne({
        _id: id(20), artistIds: [artist.toHexString()],
        credits: [credit('artist', artist), credit('organization', id(8), 1)], attributionStatus: 'documented'
    });
    const report = await reconcileContentReferences();
    const findingCount = Object.values(report).filter(Array.isArray).reduce((count, items) => count + items.length, 0);
    assert.equal(findingCount, 1);
    assert.equal(report.catalogCreditUnverified.length, 1);
    assert.equal(report.catalogCreditFindings.length, 0);
    assert.equal(report.truncated, true);
});

test('the read-only deletion audit retains orphaned failed/expired receipts and legacy owners', async () => {
    process.env.MAX_RECONCILIATION_OBJECTS = '10';
    const past = new Date(Date.now() - 300_000), future = new Date(Date.now() + 300_000);
    await getDb()!.collection('artists').insertMany([
        { _id: id(1), lifecycleStatus: 'deleting', lifecycleUpdatedAt: past, albumIds: [] },
        { _id: id(2), lifecycleStatus: 'deleting', lifecycleUpdatedAt: past, albumIds: [] }
    ]);
    await deletionReceipts().insertMany([
        { _id: `artist:${id(9)}`, ownerType: 'artist', ownerId: id(9).toHexString(), status: 'failed', leaseUntil: future },
        { _id: `album:${id(10)}`, ownerType: 'album', ownerId: id(10).toHexString(), status: 'inProgress', leaseUntil: past },
        { _id: `artist:${id(2)}`, ownerType: 'artist', ownerId: id(2).toHexString(), status: 'inProgress', leaseUntil: future }
    ]);
    const before = await fixtureSnapshot();
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogDeletionFindings.map(finding => [finding.ownerId, finding.reason]).sort(), [
        [id(1).toHexString(), 'legacyDeletion'], [id(9).toHexString(), 'deleteFailed'], [id(10).toHexString(), 'expiredLease']
    ].sort());
    assert.equal(await fixtureSnapshot(), before);
});

test('an incomplete receipt scan never invents a legacy deletion from an unseen active receipt', async () => {
    const past = new Date(Date.now() - 300_000), future = new Date(Date.now() + 300_000);
    await getDb()!.collection('artists').insertOne({
        _id: id(1), lifecycleStatus: 'deleting', lifecycleUpdatedAt: past, albumIds: []
    });
    await deletionReceipts().insertMany([
        { _id: `album:${id(10)}`, ownerType: 'album', ownerId: id(10).toHexString(), status: 'inProgress', leaseUntil: future },
        { _id: `artist:${id(1)}`, ownerType: 'artist', ownerId: id(1).toHexString(), status: 'inProgress', leaseUntil: future }
    ]);
    const report = await reconcileContentReferences();
    assert.deepEqual(report.catalogDeletionFindings, []);
    assert.equal(report.truncated, true);
});
