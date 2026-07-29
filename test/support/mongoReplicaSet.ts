import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
    lstat,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import {
    connectToDatabase,
    disconnectFromDatabase
} from '../../src/infrastructure/database';

export interface MongoReplicaSetHarness {
    stop: () => Promise<void>;
}

const testDirectoryPrefix = 'archtree-auth-test-';
const testDirectoryPattern = /^archtree-auth-test-[A-Za-z0-9_-]{6,}$/;
const ownerFilename = '.archtree-test-owner.json';
const unmarkedStaleAgeMilliseconds = 24 * 60 * 60 * 1_000;

interface TestDirectoryOwner {
    pid: number;
    createdAt: string;
}

/** Treats inaccessible process IDs as active so cleanup fails conservatively. */
const isProcessActive = (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
};

/** Confirms that cleanup actually removed the isolated database directory. */
const verifyDirectoryRemoved = async (directory: string) => {
    try {
        await lstat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new Error(`Temporary MongoDB directory was not removed: ${directory}`);
};

/** Removes only abandoned harness directories, never arbitrary temporary paths. */
export const removeStaleMongoTestDirectories = async (now = Date.now()) => {
    const temporaryRoot = tmpdir();
    const entries = await readdir(temporaryRoot, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || !testDirectoryPattern.test(entry.name)) continue;

        const directory = join(temporaryRoot, entry.name);
        const directoryStats = await lstat(directory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) continue;

        let abandoned = false;
        try {
            const owner = JSON.parse(
                await readFile(join(directory, ownerFilename), 'utf8')
            ) as TestDirectoryOwner;
            abandoned = !isProcessActive(owner.pid);
        } catch {
            abandoned = now - directoryStats.mtimeMs >= unmarkedStaleAgeMilliseconds;
        }
        if (!abandoned) continue;

        await rm(directory, { recursive: true, force: true });
        await verifyDirectoryRemoved(directory);
    }
};

/** Reserves an available loopback port before starting the isolated database. */
const availablePort = () => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(error => error ? reject(error) : resolve(port));
    });
});

/** Waits for a direct Mongo connection while retaining useful startup diagnostics. */
const waitForMongo = async (uri: string, output: () => string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
        try {
            await client.connect();
            return client;
        } catch {
            await client.close().catch(() => undefined);
            await delay(100);
        }
    }
    const diagnostics = output().trim();
    throw new Error(
        diagnostics
            ? `Timed out starting isolated MongoDB.\n${diagnostics}`
            : 'Timed out starting isolated MongoDB with no process output. '
                + 'On macOS, confirm that Gatekeeper allows the installed mongod binary.'
    );
};

/** Waits until the single-node replica set can accept transactional writes. */
const waitForPrimary = async (client: MongoClient, output: () => string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            const hello = await client.db('admin').command({ hello: 1 });
            if (hello.isWritablePrimary) return;
        } catch {
            // Election can briefly close the initiating direct connection.
        }
        await delay(100);
    }
    throw new Error(`Timed out electing isolated MongoDB primary.\n${output()}`);
};

/** Stops mongod gracefully, escalating only after its bounded shutdown window. */
const stopMongoProcess = async (mongodProcess: ChildProcessWithoutNullStreams) => {
    if (mongodProcess.exitCode !== null || mongodProcess.signalCode !== null) return;

    const closed = new Promise<void>(
        resolve => mongodProcess.once('close', () => resolve())
    );
    mongodProcess.kill('SIGTERM');
    const closedGracefully = await Promise.race([
        closed.then(() => true),
        delay(5_000).then(() => false)
    ]);
    if (closedGracefully) return;

    mongodProcess.kill('SIGKILL');
    const closedAfterKill = await Promise.race([
        closed.then(() => true),
        delay(2_000).then(() => false)
    ]);
    if (!closedAfterKill) {
        throw new Error('Temporary mongod did not exit after SIGKILL.');
    }
};

/** Starts a disposable local replica set and points the application cache at it. */
export const startMongoReplicaSet = async (
    databaseName: string
): Promise<MongoReplicaSetHarness> => {
    await removeStaleMongoTestDirectories();
    const port = await availablePort();
    const directory = await mkdtemp(join(tmpdir(), testDirectoryPrefix));
    await writeFile(
        join(directory, ownerFilename),
        JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString()
        } satisfies TestDirectoryOwner),
        { encoding: 'utf8', mode: 0o600 }
    );
    let logs = '';
    const mongodProcess: ChildProcessWithoutNullStreams = spawn('mongod', [
        '--dbpath', directory,
        '--port', String(port),
        '--bind_ip', '127.0.0.1',
        '--replSet', 'archtree-test',
        '--nounixsocket',
        '--quiet'
    ], { stdio: 'pipe' });
    const appendLog = (chunk: Buffer) => {
        logs = `${logs}${chunk.toString('utf8')}`.slice(-8_000);
    };
    mongodProcess.stdout.on('data', appendLog);
    mongodProcess.stderr.on('data', appendLog);

    const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    let directClient: MongoClient | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
        cleanupPromise ??= (async () => {
            await directClient?.close().catch(() => undefined);
            directClient = undefined;
            await disconnectFromDatabase();
            await stopMongoProcess(mongodProcess);
            await rm(directory, { recursive: true, force: true });
            await verifyDirectoryRemoved(directory);
        })();
        return cleanupPromise;
    };
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const unregisterSignalHandlers = () => {
        for (const [signal, handler] of signalHandlers) {
            process.removeListener(signal, handler);
        }
        signalHandlers.clear();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
        const handler = () => {
            unregisterSignalHandlers();
            void cleanup()
                .catch(error => console.error('Temporary MongoDB cleanup failed.', error))
                .finally(() => process.kill(process.pid, signal));
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
    }

    try {
        directClient = await waitForMongo(directUri, () => logs);
        await directClient.db('admin').command({
            replSetInitiate: {
                _id: 'archtree-test',
                members: [{ _id: 0, host: `127.0.0.1:${port}` }]
            }
        });
        await waitForPrimary(directClient, () => logs);
        await directClient.close();
        directClient = undefined;

        process.env.DB_CONN_STRING =
            `mongodb://127.0.0.1:${port}/?replicaSet=archtree-test`;
        process.env.DB_NAME = databaseName;
        process.env.JWT_SECRET = 'integration-test-jwt-secret';
        process.env.AUTH_CODE_PEPPER = 'integration-test-code-pepper';
        process.env.NODE_ENV = 'test';
        await connectToDatabase();
    } catch (error) {
        unregisterSignalHandlers();
        await cleanup();
        throw error;
    }

    return {
        stop: async () => {
            unregisterSignalHandlers();
            await cleanup();
        }
    };
};
