import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { getDb } from '../../src/infrastructure/database';
import { loadAdminCanonicalReservations } from '../../src/administration/adminCanonicalReservationService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

let harness: MongoReplicaSetHarness;
const audio = `audio/${'1'.repeat(24)}/${'2'.repeat(24)}`, image = `images/${'3'.repeat(24)}`;
const cover = (value: Record<string, unknown>) => ({ actor: 'synthetic-admin', operationId: randomUUID(), ...value });
before(async () => { harness = await startMongoReplicaSet('archtree-admin-reservations-test'); });
after(async () => { await harness?.stop(); });
beforeEach(async () => { for (const name of ['adminAlbumImports', 'adminCatalogCoverOperations']) await getDb()!.collection(name).deleteMany({}); });

test('unattached canonical copies remain referenced through import and cover lifecycle evidence', async () => {
    await getDb()!.collection('adminAlbumImports').insertOne({ media: { publication: { bucket: 'catalog', state: 'needsAttention', tracks: [{ key: audio, reused: false }, { key: 'audio/not-owned', reused: false }], cover: { key: image } } } });
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
    const publication = { bucket: 'catalog', state: 'cancelled', cleanupPending: true,
        tracks: [{ key: audio, reused: false }, { key: previous, reused: false, cleanupComplete: true }], cover: { key: image } };
    await getDb()!.collection('adminAlbumImports').insertOne({ media: { publication,
        publicationHistory: [{ ...publication, cleanupPending: false, tracks: [{ key: previous, reused: false, cleanupComplete: true }], cover: null }] } });
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set([audio, image]));
    await getDb()!.collection('adminAlbumImports').updateOne({}, { $set: { 'media.publication.cleanupPending': false } });
    assert.deepEqual(await loadAdminCanonicalReservations('catalog'), new Set());
});
