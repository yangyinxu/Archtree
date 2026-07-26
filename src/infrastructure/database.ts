import * as dotenv from 'dotenv';
import * as mongoDb from 'mongodb';

let database: mongoDb.Db | null = null;

const ensureIndexes = (db: mongoDb.Db) => {
  const indexes = [
    db.collection('pages').createIndex({ slug: 1 }, { unique: true }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('pages').createIndex({ createdBy: 1, updatedAt: -1 }),
    db.collection('carousels').createIndex({ createdBy: 1, updatedAt: -1 }),
    db.collection('audioTracks').createIndex({ artistIds: 1 }),
    db.collection('audioTracks').createIndex({ uploadStatus: 1, uploadUpdatedAt: -1 })
  ];

  Promise.allSettled(indexes).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.log(`Failed to ensure database index ${index + 1}:`, result.reason);
      }
    });
  });
};

export const connectToDatabase = async (): Promise<mongoDb.Db> => {
  dotenv.config();

  const databaseName = String(process.env.DB_NAME ?? '').trim();
  if (!databaseName) {
    throw new Error('DB_NAME is required. Refusing to start with an implicit database name.');
  }

  const client = new mongoDb.MongoClient(process.env.DB_CONN_STRING!);
  await client.connect();

  database = client.db(databaseName);
  console.log(`Successfully connected to MongoDB: ${database.databaseName}`);
  ensureIndexes(database);

  return database;
};

export const getDb = (): mongoDb.Db | null => {
  if (!database) {
    console.log(new Error('No database found from cache!'));
    return null;
  }

  return database;
};
