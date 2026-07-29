import * as dotenv from 'dotenv';
import * as mongoDb from 'mongodb';

let database: mongoDb.Db | null = null;
let databaseClient: mongoDb.MongoClient | null = null;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const ensureIndexes = async (db: mongoDb.Db) => {
  const indexes: Array<{
    collection: string;
    keys: mongoDb.IndexSpecification;
    options?: mongoDb.CreateIndexesOptions;
  }> = [
    { collection: 'pages', keys: { slug: 1 }, options: { unique: true } },
    { collection: 'users', keys: { email: 1 }, options: { unique: true } },
    { collection: 'users', keys: { username: 1 } },
    { collection: 'authSessions', keys: { refreshTokenHash: 1 }, options: { unique: true } },
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
    { collection: 'userActivity', keys: { userId: 1 }, options: { unique: true } },
    { collection: 'pages', keys: { createdBy: 1, updatedAt: -1 } },
    { collection: 'carousels', keys: { createdBy: 1, updatedAt: -1 } },
    { collection: 'artists', keys: { createdBy: 1 } },
    { collection: 'albums', keys: { createdBy: 1 } },
    { collection: 'audioTracks', keys: { createdBy: 1 } },
    { collection: 'audioTracks', keys: { artistIds: 1 } },
    { collection: 'audioTracks', keys: { uploadStatus: 1, uploadUpdatedAt: -1 } },
    { collection: 'posts', keys: { createdAt: -1 } }
  ];

  for (const [index, definition] of indexes.entries()) {
    try {
      await db.collection(definition.collection).createIndex(definition.keys, definition.options ?? {});
    } catch (error) {
      console.log(`Failed to ensure database index ${index + 1}:`, error);
    }
  }
};

export const connectToDatabase = async (): Promise<mongoDb.Db> => {
  dotenv.config();

  const databaseName = String(process.env.DB_NAME ?? '').trim();
  if (!databaseName) {
    throw new Error('DB_NAME is required. Refusing to start with an implicit database name.');
  }

  const client = new mongoDb.MongoClient(process.env.DB_CONN_STRING!, {
    connectTimeoutMS: positiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
    serverSelectionTimeoutMS: positiveInteger(process.env.DB_SERVER_SELECTION_TIMEOUT_MS, 10_000),
    socketTimeoutMS: positiveInteger(process.env.DB_SOCKET_TIMEOUT_MS, 120_000),
    waitQueueTimeoutMS: positiveInteger(process.env.DB_WAIT_QUEUE_TIMEOUT_MS, 10_000),
    maxPoolSize: positiveInteger(process.env.DB_MAX_POOL_SIZE, 100)
  });
  await client.connect();

  databaseClient = client;
  database = client.db(databaseName);
  console.log(`Successfully connected to MongoDB: ${database.databaseName}`);
  void ensureIndexes(database);

  return database;
};

export const getDb = (): mongoDb.Db | null => {
  if (!database) {
    console.log(new Error('No database found from cache!'));
    return null;
  }

  return database;
};

/** Exposes the connected client for bounded multi-collection transactions. */
export const getDatabaseClient = (): mongoDb.MongoClient => {
  if (!databaseClient) {
    throw new Error('Database client is not connected.');
  }
  return databaseClient;
};
