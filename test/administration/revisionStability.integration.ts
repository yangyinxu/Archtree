/**
 * Pins the identity and create receipt that the real createAdminImport persists for a draftless
 * body. A retry admitted before a deploy replays only while both values stay unchanged; a new hash
 * recipe or default-draft path rejects that retry with ADMIN_IMPORT_OPERATION_CONFLICT. The unit
 * gate in revisionStability.test.ts checks the same values without MongoDB but cannot see which
 * inputs the service hashes, so this file is the guard against that drift.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../../src/infrastructure/database';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';
import { createAdminImport, initializeAdminImportStorage } from '../../src/administration/import/adminImportService';

const golden = JSON.parse(readFileSync(new URL('../fixtures/revisionStability/draftless-import-create.json', import.meta.url), 'utf8'));
let harness: MongoReplicaSetHarness;
before(async () => {
    harness = await startMongoReplicaSet('archtree-revision-stability-test');
    process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'true'; const db = getDb()!;
    await db.collection('users').insertOne({ _id: new ObjectId(golden.actor), email: 'revision-stability@example.test', role: 'admin' });
    await initializeAdminImportStorage(db);
});
after(async () => { delete process.env.FINITUDE_ADMIN_IMPORTS_ENABLED; await harness?.stop(); });

test('a draftless create persists its frozen identity and receipt hash, and a same-body retry replays it', async () => {
    const created = await createAdminImport(golden.actor, golden.body);
    assert.equal(created.item.id, golden.importId, 'import identity');
    const stored = await getDb()!.collection('adminAlbumImports').findOne({ _id: new ObjectId(created.item.id) });
    assert.equal(stored!.receipts.length, 1);
    assert.equal(stored!.receipts[0].hash, golden.createReceiptHash, 'create receipt hash');
    const replay = await createAdminImport(golden.actor, golden.body);
    assert.deepEqual([replay.item.id, replay.receipt], [golden.importId, { operationId: golden.body.operationId, kind: 'create', revision: 1 }]);
    assert.equal(await getDb()!.collection('adminAlbumImports').countDocuments(), 1);
});
