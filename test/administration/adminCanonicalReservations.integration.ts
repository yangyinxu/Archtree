import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { getDb } from '../../src/infrastructure/database';
import { loadAdminCanonicalReservations } from '../../src/administration/adminCanonicalReservationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const audio = `audio/${'1'.repeat(24)}/${'2'.repeat(24)}`, image = `images/${'3'.repeat(24)}`;
const cover = (value: Record<string, unknown>) => ({ actor: 'synthetic-admin', operationId: randomUUID(), ...value });
/** Every stored v1 approval froze its v1 draft; only such an approval is read as format 1. */
const snapshot = { album: { title: 'Synthetic Album', artistName: 'Synthetic Artist', releaseDate: null, visibility: 'hidden' }, tracks: [] };
before(async () => { harness = await startMongoReplicaSet('archtree-admin-reservations-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => { for (const name of ['adminAlbumImports', 'adminCatalogCoverOperations']) await getDb()!.collection(name).deleteMany({}); });

test('unattached canonical copies remain referenced through import and cover lifecycle evidence', async () => {
    await getDb()!.collection('adminAlbumImports').insertOne({ media: { publication: { bucket: 'catalog', state: 'needsAttention', snapshot, tracks: [{ key: audio, reused: false }, { key: 'audio/not-owned', reused: false }], cover: { key: image } } } });
    await getDb()!.collection('adminCatalogCoverOperations').insertMany([
        { target: { bucket: 'catalog', key: image }, state: 'copying', cleanupPending: false },
        { target: { bucket: 'private-staging', key: `images/${'4'.repeat(24)}` }, state: 'copying' }
    ].map(cover));
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
});
test('confirmed history releases reservations while cancelled unresolved cleanup stays traceable', async () => {
    await getDb()!.collection('adminAlbumImports').insertOne({ media: { publication: { bucket: 'catalog', state: 'complete', tracks: [{ key: audio, reused: false }] } } });
    await getDb()!.collection('adminCatalogCoverOperations').insertMany([
        { target: { bucket: 'catalog', key: image }, state: 'cancelled', cleanupPending: true },
        { target: { bucket: 'catalog', key: `images/${'4'.repeat(24)}` }, state: 'cancelled', cleanupPending: false },
        { target: { bucket: 'catalog', key: `images/${'5'.repeat(24)}` }, state: 'complete', cleanupPending: false }
    ].map(cover));
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([image]));
});
test('reservation audits reject unbounded inventory instead of classifying omitted evidence as orphaned', async () => {
    await getDb()!.collection('adminCatalogCoverOperations').insertMany([
        { target: { bucket: 'catalog', key: image }, state: 'copying' },
        { target: { bucket: 'catalog', key: `images/${'4'.repeat(24)}` }, state: 'copying' }
    ].map(cover));
    await assert.rejects(loadAdminCanonicalReservations('catalog', 1), /safety limit/);
});

test('cancelled import cleanup reserves unresolved copies and releases only confirmed-clean parts and histories', async () => {
    const previous = `audio/${'6'.repeat(24)}/${'7'.repeat(24)}`;
    const publication = { bucket: 'catalog', state: 'cancelled', cleanupPending: true, snapshot,
        tracks: [{ key: audio, reused: false }, { key: previous, reused: false, cleanupComplete: true }], cover: { key: image } };
    await getDb()!.collection('adminAlbumImports').insertOne({ media: { publication,
        publicationHistory: [{ ...publication, cleanupPending: false, tracks: [{ key: previous, reused: false, cleanupComplete: true }], cover: null }] } });
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
    await getDb()!.collection('adminAlbumImports').updateOne({}, { $set: { 'media.publication.cleanupPending': false } });
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set());
});
test('an unresolved approval of an unknown publication format fails reconciliation closed, while known and settled formats do not', async () => {
    const imports = getDb()!.collection('adminAlbumImports');
    const approval = (value: Record<string, unknown>) => ({ media: { publication: { bucket: 'catalog', state: 'needsAttention', snapshot, tracks: [{ key: audio, reused: false }], cover: { key: image }, ...value } } });
    // Absent and explicit format 1 reserve exactly as before; a completed approval of any format reserves nothing.
    await imports.insertMany([approval({}), approval({ schemaVersion: 1 }), approval({ schemaVersion: 2, state: 'complete', tracks: [{ key: `audio/${'8'.repeat(24)}/${'9'.repeat(24)}`, reused: false }] })]);
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
    // A newer approval in another bucket cannot reserve objects of this one.
    await imports.insertOne(approval({ schemaVersion: 2, bucket: 'other-catalog' }));
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
    // A state this release does not know is unresolved too, and so is a newer snapshot whose format was not recorded.
    const v2Snapshot = { album: { title: 'Synthetic Album', artists: [{ name: 'Synthetic Artist', role: 'primary' }], label: null, releaseDate: null, visibility: 'hidden' }, tracks: [] };
    for (const value of [{ schemaVersion: 2, state: 'preparing' }, { schemaVersion: 2 }, { schemaVersion: 2, state: 'cancelled', cleanupPending: true }, { schemaVersion: 2, state: 'confirming' }, { schemaVersion: '1' }, { schemaVersion: 0 },
        { snapshot: v2Snapshot }, { schemaVersion: 1, snapshot: v2Snapshot }, { snapshot: undefined }]) {
        const { insertedId } = await imports.insertOne(approval(value));
        await assert.rejects(loadAdminCanonicalReservations('catalog'), /newer import publication format/, JSON.stringify(value));
        await imports.deleteOne({ _id: insertedId });
    }
    // A cancelled newer approval whose cleanup is confirmed is settled and no longer blocks reconciliation.
    await imports.insertOne(approval({ schemaVersion: 2, state: 'cancelled', cleanupPending: false }));
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
});
