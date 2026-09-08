import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db, Document } from 'mongodb';
import {
  databaseIndexes, DatabaseCollectionInitializationError, DatabaseIndexInitializationError, initializeDatabaseIndexes,
  requiredIndexRevision, verifyRequiredDatabaseIndexes
} from '../src/infrastructure/databaseIndexes';

/** Simulates server index metadata without opening a network connection. */
const databaseDouble = () => {
  const metadata = new Map<string, Document[]>();
  const receipts: string[] = [];
  const collections = new Set<string>();
  const collectionAttempts: string[] = [];
  let failCreate: string | undefined;
  const db = {
    createCollection: async (name: string, options: Document) => {
      collectionAttempts.push(name);
      assert.deepEqual(options, { maxTimeMS: 5_000 });
      if (collections.has(name)) throw Object.assign(new Error('NamespaceExists'), { code: 48 });
      collections.add(name);
    },
    collection: (name: string) => ({
    createIndex: async (key: unknown, options: Document) => {
      if (name === failCreate) throw new Error('private-email@example.test');
      const indexes = metadata.get(name) ?? [];
      if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key))) {
        indexes.push({ key, unique: options.unique });
        metadata.set(name, indexes);
      }
    },
    listIndexes: () => ({ toArray: async () => metadata.get(name) ?? [] }),
    updateOne: async (filter: { _id: string }) => { receipts.push(filter._id); }
  }) } as unknown as Db;
  return { db, metadata, receipts, collections, collectionAttempts, fail: (name: string) => { failCreate = name; } };
};

test('index migration is additive, repeatable, and records its verified revision', async () => {
  const fake = databaseDouble();
  await initializeDatabaseIndexes(fake.db);
  await initializeDatabaseIndexes(fake.db);
  assert.deepEqual(fake.receipts, [requiredIndexRevision, requiredIndexRevision]);
  assert.equal([...fake.metadata.values()].flat().length, databaseIndexes.length);
  assert.deepEqual([...fake.collections], ['catalogDeletionOperations']);
  assert.deepEqual(fake.collectionAttempts, ['catalogDeletionOperations', 'catalogDeletionOperations']);
  await verifyRequiredDatabaseIndexes(fake.db);
  assert.equal(fake.collectionAttempts.length, 2);
});

test('receipt collection creation accepts only NamespaceExists code and fails safely before index writes', async () => {
  for (const error of [
    Object.assign(new Error('private permission detail'), { code: 13 }),
    Object.assign(new Error('private creation detail'), { code: 91 }),
    Object.assign(new Error('NamespaceExists private detail'), { codeName: 'NamespaceExists' }),
    Object.assign(new Error('private string code'), { code: '48' })
  ]) {
    const fake = databaseDouble();
    fake.db.createCollection = async () => { throw error; };
    await assert.rejects(initializeDatabaseIndexes(fake.db), failure => {
      assert.ok(failure instanceof DatabaseCollectionInitializationError);
      assert.equal(failure.code, 'database_collection_unavailable');
      assert.equal(failure.message, 'Required database collection is unavailable: catalogDeletionOperations');
      assert.equal('cause' in failure, false);
      return true;
    });
    assert.equal(fake.metadata.size, 0);
    assert.deepEqual(fake.receipts, []);
  }
});

test('mandatory index failure prevents migration success without disclosing database errors', async () => {
  const fake = databaseDouble();
  fake.fail('users');
  await assert.rejects(initializeDatabaseIndexes(fake.db), error => {
    assert.ok(error instanceof DatabaseIndexInitializationError);
    assert.equal(error.indexId, 'users:email');
    assert.equal(String(error).includes('private-email'), false);
    return true;
  });
  assert.deepEqual(fake.receipts, []);
});

test('nonunique, sparse, partial, and incompatible collation constraints fail verification', async () => {
  for (const altered of [
    { unique: false }, { sparse: true }, { partialFilterExpression: { active: true } },
    { collation: { locale: 'en', strength: 2 } }
  ]) {
    const fake = databaseDouble();
    await initializeDatabaseIndexes(fake.db);
    Object.assign(fake.metadata.get('users')![0], altered);
    await assert.rejects(verifyRequiredDatabaseIndexes(fake.db), DatabaseIndexInitializationError);
  }
});

test('a dropped required index makes a previously initialized database unready', async () => {
  const fake = databaseDouble();
  await initializeDatabaseIndexes(fake.db);
  fake.metadata.set('passkeys', []);
  await assert.rejects(verifyRequiredDatabaseIndexes(fake.db), /passkeys:credentialId/);
});

test('optional performance-index failure preserves required constraints and emits bounded diagnostics', async () => {
  const fake = databaseDouble();
  fake.fail('posts');
  const entries: string[] = [];
  const warn = console.warn;
  console.warn = (entry: string) => { entries.push(entry); };
  try { await initializeDatabaseIndexes(fake.db); } finally { console.warn = warn; }
  assert.deepEqual(entries.map(entry => JSON.parse(entry)), [
    { category: 'optional_index_unavailable', indexId: 'posts:createdAt' }
  ]);
  assert.equal(fake.receipts.length, 1);
});

test('a failed metadata read does not finish verification while another read occupies the pool', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let settled = false;
  const db = { collection: (name: string) => ({ listIndexes: () => ({ toArray: async () => {
    if (name === 'users') throw new Error('synthetic failure');
    if (name === 'pages') {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
    return [];
  } }) }) } as unknown as Db;
  const checked = verifyRequiredDatabaseIndexes(db).then(() => { settled = true; }, () => { settled = true; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await checked;
  assert.equal(settled, true);
});
