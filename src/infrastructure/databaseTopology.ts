import type { Db, Document } from 'mongodb';

/** A fixed failure category; topology replies and connection details stay private. */
export class DatabaseTopologyUnavailableError extends Error {
  readonly code = 'database_topology_unavailable';
  constructor() {
    super('MongoDB must provide a writable replica set or mongos with transaction support.');
  }
}

/** Checks transaction prerequisites without starting a session, transaction, or write. */
export const verifyDatabaseTransactionTopology = async (db: Pick<Db, 'command'>): Promise<void> => {
  try {
    const options = { maxTimeMS: 1_000, readPreference: 'primary' as const };
    let hello: Document;
    try {
      hello = await db.command({ hello: 1 }, options);
    } catch (error) {
      // Transaction-capable older servers expose the same fields under legacy hello.
      if ((error as { code?: unknown })?.code !== 59) throw error;
      hello = await db.command({ isMaster: 1 }, options);
    }
    const mongos = hello.msg === 'isdbgrid';
    const replicaSet = typeof hello.setName === 'string' && hello.setName.length > 0;
    const writable = hello.isWritablePrimary === true
      || (hello.isWritablePrimary === undefined && hello.ismaster === true);
    const sessions = Number.isFinite(hello.logicalSessionTimeoutMinutes)
      && hello.logicalSessionTimeoutMinutes > 0;
    // Catalog leases also require MongoDB 4.2 update pipelines, even on replica sets.
    const transactions = Number.isInteger(hello.maxWireVersion)
      && hello.maxWireVersion >= 8;
    if ((!mongos && !replicaSet) || !writable || !sessions || !transactions) {
      throw new DatabaseTopologyUnavailableError();
    }
  } catch {
    throw new DatabaseTopologyUnavailableError();
  }
};
