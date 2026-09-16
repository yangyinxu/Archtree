import type { Db, CreateIndexesOptions, IndexSpecification, Document } from 'mongodb';
import { catalogSearchCollections } from '../utils/catalogSearch';

const catalogSearchIndexKeys: IndexSpecification[] = [
  { catalogSearchVersion: 1 },
  { catalogSearchGrams: 1, catalogSearchVersion: 1 }
];

/** Versioned index definitions; unique constraints are mandatory for correctness. */
export const databaseIndexes: Array<{
    collection: string;
    keys: IndexSpecification;
    options?: CreateIndexesOptions;
    /** Required nonunique indexes bound transactional cleanup and provision its collections. */
    required?: boolean;
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
    { collection: 'socialProfiles', keys: { accountId: 1 }, options: { unique: true } },
    { collection: 'socialProfiles', keys: { handle: 1 }, options: { unique: true } },
    { collection: 'socialRelationships', keys: { accountIds: 1 }, required: true },
    { collection: 'socialRelationships', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    {
      collection: 'socialMutations', keys: { accountId: 1, scopeId: 1, commandId: 1 },
      options: { unique: true }
    },
    { collection: 'socialMutations', keys: { accountId: 1, expiresAt: 1 } },
    { collection: 'socialMutations', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'socialOutbox', keys: { accountId: 1 }, options: { unique: true } },
    { collection: 'socialBudgets', keys: { accountId: 1 }, options: { unique: true } },
    { collection: 'socialHandles', keys: { accountId: 1 }, required: true },
    { collection: 'socialHandles', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'socialMusicShares', keys: { senderAccountId: 1, createdAt: -1, _id: -1 }, required: true },
    { collection: 'socialMusicShares', keys: { recipientAccountId: 1, createdAt: -1, _id: -1 }, required: true },
    { collection: 'socialMusicShares', keys: { accountIds: 1 }, required: true },
    { collection: 'socialMusicShares', keys: { contentType: 1, contentId: 1, _id: 1 }, required: true },
    { collection: 'socialMusicShares', keys: { senderAccountId: 1, recipientAccountId: 1, contentType: 1, contentId: 1 }, required: true },
    { collection: 'socialMusicShares', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'socialListeningStates', keys: { accountId: 1 }, options: { unique: true } },
    { collection: 'socialListeningPublications', keys: { 'playback.mediaTrackId': 1, _id: 1 }, required: true },
    { collection: 'socialListeningPublications', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'socialRooms', keys: { state: 1, expiresAt: 1 }, required: true },
    { collection: 'socialRooms', keys: { 'members.accountId': 1 }, required: true },
    { collection: 'socialRooms', keys: { 'queue.mediaTrackId': 1 }, required: true },
    { collection: 'socialRooms', keys: { 'songRequests.mediaTrackId': 1 }, required: true },
    { collection: 'socialRooms', keys: { closedAt: 1 }, options: { expireAfterSeconds: 86_400 } },
    { collection: 'socialRoomParticipation', keys: { roomId: 1 }, required: true },
    { collection: 'socialInvitations', keys: { invitationId: 1 }, options: { unique: true } },
    { collection: 'socialInvitations', keys: { recipientAccountId: 1, state: 1 }, required: true },
    { collection: 'socialInvitations', keys: { senderAccountId: 1, state: 1 }, required: true },
    { collection: 'socialInvitations', keys: { roomId: 1 }, required: true },
    { collection: 'socialInvitations', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    { collection: 'socialRoomOutbox', keys: { roomId: 1 }, options: { unique: true } },
    { collection: 'socialRoomOutbox', keys: { updatedAt: 1 }, options: { expireAfterSeconds: 86_400 } },
    { collection: 'socialAuthority', keys: { owner: 1 }, required: true },
    { collection: 'socialRealtimeTickets', keys: { accountId: 1, expiresAt: 1 }, required: true },
    { collection: 'socialRealtimeTickets', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
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
    { collection: 'posts', keys: { createdAt: -1 } },
    ...Object.keys(catalogSearchCollections).flatMap(collection =>
      catalogSearchIndexKeys.map(keys => ({ collection, keys })))
  ];

export const requiredIndexRevision = 'required-indexes-v4-social-participation';
const requiredIndexes = databaseIndexes.filter(index => index.options?.unique === true || index.required);

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

/** Accepts complete constraints and cleanup indexes, never sparse or partial substitutes. */
const matchesRequiredIndex = (actual: Document, expected: typeof databaseIndexes[number]) =>
  JSON.stringify(actual.key) === JSON.stringify(expected.keys)
  && (expected.options?.unique === true ? actual.unique === true : !actual.unique)
  && !actual.sparse
  && !actual.partialFilterExpression
  && !actual.hidden
  && actual.expireAfterSeconds === expected.options?.expireAfterSeconds
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
      if (definition.options?.unique || definition.required) {
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
