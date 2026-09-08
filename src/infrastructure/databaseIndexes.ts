import type { Db, CreateIndexesOptions, IndexSpecification, Document } from 'mongodb';

/** Versioned index definitions; unique constraints are mandatory for correctness. */
export const databaseIndexes: Array<{
    collection: string;
    keys: IndexSpecification;
    options?: CreateIndexesOptions;
  }> = [
    { collection: 'pages', keys: { slug: 1 }, options: { unique: true } },
    { collection: 'users', keys: { email: 1 }, options: { unique: true } },
    { collection: 'users', keys: { username: 1 } },
    { collection: 'authSessions', keys: { refreshTokenHash: 1 }, options: { unique: true } },
    { collection: 'authSessions', keys: { previousRefreshTokenHash: 1 }, options: { sparse: true } },
    { collection: 'authSessions', keys: { userId: 1, revokedAt: 1, expiresAt: -1 } },
    { collection: 'authSessions', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'authActionTokens', keys: { codeHash: 1 } },
    { collection: 'authActionTokens', keys: { userId: 1, purpose: 1, consumedAt: 1 } },
    { collection: 'authActionTokens', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'authIdentities', keys: { provider: 1, providerSubject: 1 }, options: { unique: true } },
    { collection: 'authIdentities', keys: { userId: 1, provider: 1 }, options: { unique: true } },
    { collection: 'passkeys', keys: { credentialId: 1 }, options: { unique: true } },
    { collection: 'passkeys', keys: { userId: 1, createdAt: -1 } },
    { collection: 'passkeyChallenges', keys: { flowId: 1 }, options: { unique: true } },
    { collection: 'passkeyChallenges', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'userSaves', keys: { userId: 1, contentType: 1, contentId: 1 }, options: { unique: true } },
    { collection: 'userSaves', keys: { userId: 1, savedAt: -1 } },
    { collection: 'userSaves', keys: { userId: 1, lastPlayedAt: -1, _id: -1 } },
    { collection: 'userSaves', keys: { userId: 1, lastActivityAt: -1, _id: -1 } },
    { collection: 'userActivity', keys: { userId: 1 }, options: { unique: true } },
    { collection: 'playlists', keys: { ownerUserId: 1, updatedAt: -1, _id: -1 } },
    {
      collection: 'accountMutations',
      keys: { ownerUserId: 1, idempotencyKeyHash: 1 },
      options: { unique: true }
    },
    { collection: 'accountMutations', keys: { ownerUserId: 1, expiresAt: 1 } },
    {
      collection: 'accountMutations',
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 }
    },
    { collection: 'pages', keys: { createdBy: 1, updatedAt: -1 } },
    { collection: 'contentWorkflowOperations', keys: { adminUserId: 1, updatedAt: -1 } },
    {
      collection: 'contentWorkflowOperations',
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 }
    },
    { collection: 'carousels', keys: { createdBy: 1, updatedAt: -1 } },
    { collection: 'contentCollections', keys: { createdBy: 1, updatedAt: -1 } },
    { collection: 'artists', keys: { createdBy: 1 } },
    { collection: 'artists', keys: { name: 1, _id: 1 } },
    { collection: 'organizations', keys: { name: 1, _id: 1 } },
    { collection: 'organizations', keys: { organizationType: 1, name: 1 } },
    { collection: 'organizations', keys: { createdBy: 1 } },
    { collection: 'albums', keys: { createdBy: 1 } },
    { collection: 'albums', keys: { title: 1, _id: 1 } },
    { collection: 'albums', keys: { 'credits.subjectType': 1, 'credits.subjectId': 1, 'credits.role': 1 } },
    { collection: 'audioTracks', keys: { createdBy: 1 } },
    { collection: 'audioTracks', keys: { title: 1, _id: 1 } },
    { collection: 'audioTracks', keys: { artistIds: 1 } },
    { collection: 'audioTracks', keys: { 'credits.subjectType': 1, 'credits.subjectId': 1, 'credits.role': 1 } },
    { collection: 'audioTracks', keys: { uploadStatus: 1, uploadUpdatedAt: -1 } },
    { collection: 'audioTracks', keys: { publicationStatus: 1, uploadStatus: 1 } },
    { collection: 'imageAssets', keys: { ownerType: 1, ownerId: 1, _id: 1 } },
    { collection: 'imageAssets', keys: { createdBy: 1, ownerType: 1 } },
    { collection: 'posts', keys: { createdAt: -1 } }
  ];

export const requiredIndexRevision = 'required-indexes-v1';
const requiredIndexes = databaseIndexes.filter(index => index.options?.unique === true);

/** Reports a static schema identifier without retaining database errors or user values. */
export class DatabaseIndexInitializationError extends Error {
  readonly code = 'database_index_unavailable';
  constructor(readonly indexId: string) {
    super(`Required database constraint is unavailable: ${indexId}`);
  }
}

/** Keeps collection-creation failures private while preventing an incomplete startup. */
export class DatabaseCollectionInitializationError extends Error {
  readonly code = 'database_collection_unavailable';
  constructor() {
    super('Required database collection is unavailable: catalogDeletionOperations');
  }
}

const indexId = (index: typeof databaseIndexes[number]) =>
  `${index.collection}:${Object.keys(index.keys).join(',')}`;

/** Accepts only the complete unique constraint, never a sparse or partial substitute. */
const matchesRequiredIndex = (actual: Document, expected: typeof databaseIndexes[number]) =>
  JSON.stringify(actual.key) === JSON.stringify(expected.keys)
  && actual.unique === true
  && !actual.sparse
  && !actual.partialFilterExpression
  && (!actual.collation || actual.collation.locale === 'simple');

/** Reads bounded schema metadata without inspecting or repairing account records. */
export const verifyRequiredDatabaseIndexes = async (db: Db): Promise<void> => {
  const metadata = new Map<string, Document[]>();
  const reads = await Promise.allSettled([...new Set(requiredIndexes.map(index => index.collection))].map(async collection => {
    try {
      metadata.set(collection, await db.collection(collection).listIndexes({ maxTimeMS: 1_000 }).toArray());
    } catch {
      throw new DatabaseIndexInitializationError(collection);
    }
  }));
  // Retain diagnostic admission until every metadata read has stopped using the pool.
  const failure = reads.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  for (const definition of requiredIndexes) {
    try {
      const indexes = metadata.get(definition.collection)!;
      if (!indexes.some(actual => matchesRequiredIndex(actual, definition))) {
        throw new DatabaseIndexInitializationError(indexId(definition));
      }
    } catch {
      throw new DatabaseIndexInitializationError(indexId(definition));
    }
  }
};

/** Applies additive index migrations and records success only after verifying constraints. */
export const initializeDatabaseIndexes = async (db: Db): Promise<void> => {
  // The first deletion transaction must not also create its durable receipt collection.
  // This is required on MongoDB 4.2 and for cross-shard transactions on newer servers.
  try {
    await db.createCollection('catalogDeletionOperations', { maxTimeMS: 5_000 });
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 48) {
      throw new DatabaseCollectionInitializationError();
    }
  }
  for (const definition of databaseIndexes) {
    try {
      await db.collection(definition.collection).createIndex(
        definition.keys, { ...definition.options, maxTimeMS: 120_000 }
      );
    } catch {
      if (definition.options?.unique) {
        throw new DatabaseIndexInitializationError(indexId(definition));
      }
      console.warn(JSON.stringify({ category: 'optional_index_unavailable', indexId: indexId(definition) }));
    }
  }
  await verifyRequiredDatabaseIndexes(db);
  try {
    await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').updateOne(
      { _id: requiredIndexRevision }, { $setOnInsert: { appliedAt: new Date() } },
      { upsert: true, maxTimeMS: 5_000 }
    );
  } catch {
    throw new DatabaseIndexInitializationError(requiredIndexRevision);
  }
};
