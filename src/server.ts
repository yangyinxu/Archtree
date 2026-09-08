import { Server } from 'node:http';

import { createApp } from './app';
import { connectToDatabase, disconnectFromDatabase } from './infrastructure/database';
import { accessTokenDurationSeconds } from './services/authSessionService';
import { installShutdownHandlers, ServerLifecycle } from './services/serverLifecycleService';
import { recordStartupFailureStage, type StartupStage } from './infrastructure/startupDiagnostics';

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Allows isolated startup-failure tests without accessing configured infrastructure. */
export interface ServerDependencies {
  connectDatabase?: () => Promise<unknown>;
  closeDatabase?: () => Promise<void>;
  createApplication?: typeof createApp;
  port?: number;
  stopped?: (outcome: 'graceful' | 'forced') => void;
}

/** Resolves only after listening, and releases infrastructure on every startup failure. */
export const startServer = async (dependencies: ServerDependencies = {}): Promise<Server> => {
  const closeDatabase = dependencies.closeDatabase ?? disconnectFromDatabase;
  const lifecycle = new ServerLifecycle();
  const server = new Server();
  const cleanupMs = () => Math.min(30_000, positiveInteger(process.env.SERVER_SHUTDOWN_CLEANUP_MS, 5_000));
  let stage: StartupStage = 'database_connection';
  try {
    await (dependencies.connectDatabase ?? connectToDatabase)();
    stage = 'application';
    const app = (dependencies.createApplication ?? createApp)({ lifecycle });
    server.on('request', app);
    stage = 'listener_configuration';
    const port = dependencies.port ?? Number(process.env.PORT || process.env.port || 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT must be a valid TCP port.');

    server.headersTimeout = positiveInteger(process.env.SERVER_HEADERS_TIMEOUT_MS, 60_000);
    server.requestTimeout = positiveInteger(process.env.SERVER_REQUEST_TIMEOUT_MS, 15 * 60_000);
    server.keepAliveTimeout = positiveInteger(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 5_000);
    server.timeout = positiveInteger(process.env.SERVER_INACTIVITY_TIMEOUT_MS, 120_000);
    server.maxRequestsPerSocket = positiveInteger(process.env.SERVER_MAX_REQUESTS_PER_SOCKET, 1_000);
    server.maxConnections = positiveInteger(process.env.SERVER_MAX_CONNECTIONS, 1_000);
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.destroy();
    });

    stage = 'listener';
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', listening); reject(error); };
      const listening = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen(port);
    });
    console.log(JSON.stringify({ category: 'server_listening', accessTokenSeconds: accessTokenDurationSeconds() }));
    const stopped = dependencies.stopped ?? (outcome => {
      console.log(JSON.stringify({ category: 'server_stopped', outcome }));
      process.exit(outcome === 'graceful' ? 0 : 1);
    });
    const disposeShutdown = installShutdownHandlers(
      server, lifecycle, closeDatabase,
      Math.min(120_000, positiveInteger(process.env.SERVER_SHUTDOWN_GRACE_MS, 30_000)),
      cleanupMs(), stopped
    );
    server.once('close', () => { if (!lifecycle.draining) disposeShutdown(); });
    server.once('error', () => {
      void lifecycle.stop(server, closeDatabase, 1_000, cleanupMs()).then(stopped);
    });
    return server;
  } catch (error) {
    await lifecycle.stop(server, closeDatabase, 1_000, cleanupMs());
    throw recordStartupFailureStage(error, stage);
  }
};
