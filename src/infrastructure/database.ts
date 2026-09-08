import * as dotenv from 'dotenv';
import * as mongoDb from 'mongodb';
import { initializeDatabaseIndexes, verifyRequiredDatabaseIndexes } from './databaseIndexes';
import { verifyDatabaseTransactionTopology } from './databaseTopology';
import { MissingStartupConfigurationError, recordStartupFailureStage, type StartupStage } from './startupDiagnostics';

let database: mongoDb.Db | null = null;
let databaseClient: mongoDb.MongoClient | null = null;
let readinessCheckedAt = 0;
let readinessCheck: Promise<boolean> | undefined;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const connectToDatabase = async (): Promise<mongoDb.Db> => {
  let stage: StartupStage = 'configuration';
  let client: mongoDb.MongoClient | undefined;
  try {
    dotenv.config();
    const missingVariables = (['DB_CONN_STRING', 'DB_NAME'] as const)
      .filter(name => !String(process.env[name] ?? '').trim());
    if (missingVariables.length) throw new MissingStartupConfigurationError(missingVariables);
    const databaseName = process.env.DB_NAME!.trim();
    client = new mongoDb.MongoClient(process.env.DB_CONN_STRING!, {
      connectTimeoutMS: positiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
      serverSelectionTimeoutMS: positiveInteger(process.env.DB_SERVER_SELECTION_TIMEOUT_MS, 10_000),
      socketTimeoutMS: positiveInteger(process.env.DB_SOCKET_TIMEOUT_MS, 120_000),
      waitQueueTimeoutMS: positiveInteger(process.env.DB_WAIT_QUEUE_TIMEOUT_MS, 10_000),
      maxPoolSize: positiveInteger(process.env.DB_MAX_POOL_SIZE, 100)
    });
    stage = 'database_connection';
    await client.connect();
    const connectedDatabase = client.db(databaseName);
    stage = 'database_topology';
    await verifyDatabaseTransactionTopology(connectedDatabase);
    stage = 'database_initialization';
    await initializeDatabaseIndexes(connectedDatabase);
    databaseClient = client;
    database = connectedDatabase;
    readinessCheckedAt = Date.now();
    console.log(JSON.stringify({ category: 'database_ready' }));
    return connectedDatabase;
  } catch (error) {
    await client?.close().catch(() => undefined);
    throw recordStartupFailureStage(error, stage);
  }
};

export const getDb = (): mongoDb.Db | null => {
  return database;
};

/** Exposes the connected client for bounded multi-collection transactions. */
export const getDatabaseClient = (): mongoDb.MongoClient => {
  if (!databaseClient) {
    throw new Error('Database client is not connected.');
  }
  return databaseClient;
};

/** Closes and clears the cached connection so isolated test databases cannot leak state. */
export const disconnectFromDatabase = async () => {
  const client = databaseClient;
  database = null;
  databaseClient = null;
  readinessCheckedAt = 0;
  readinessCheck = undefined;
  await client?.close();
};

/** Rechecks transaction topology and required constraints without starting transactions. */
export const checkDatabaseReadiness = async (): Promise<boolean> => {
  const connectedDatabase = database;
  if (!connectedDatabase) return false;
  if (Date.now() - readinessCheckedAt < 30_000) return true;
  if (!readinessCheck) {
    const check = Promise.allSettled([
      verifyDatabaseTransactionTopology(connectedDatabase),
      verifyRequiredDatabaseIndexes(connectedDatabase)
    ])
      .then(results => {
        if (results.some(result => result.status === 'rejected')) return false;
        if (database !== connectedDatabase) return false;
        readinessCheckedAt = Date.now();
        return true;
      })
      .catch(() => false)
      .finally(() => { if (readinessCheck === check) readinessCheck = undefined; });
    readinessCheck = check;
  }
  return readinessCheck;
};
