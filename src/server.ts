import { Server } from 'node:http';

import { createApp } from './app';
import { connectToDatabase } from './infrastructure/database';
import { accessTokenDurationSeconds } from './services/authSessionService';

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Connects infrastructure and starts the configured HTTP server process. */
export const startServer = async (): Promise<Server> => {
  console.log(`Service environment: ${process.env.NODE_ENV}`);
  console.log(`Authentication access-token lifetime: ${accessTokenDurationSeconds()} seconds`);

  await connectToDatabase();
  const app = createApp();
  const port: string | number = process.env.PORT || process.env.port || 8080;
  const server = app.listen(port, () => {
    console.log(`Starting service on port ${port}...`);
  });

  server.headersTimeout = positiveInteger(process.env.SERVER_HEADERS_TIMEOUT_MS, 60_000);
  server.requestTimeout = positiveInteger(process.env.SERVER_REQUEST_TIMEOUT_MS, 15 * 60_000);
  server.keepAliveTimeout = positiveInteger(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 5_000);
  server.timeout = positiveInteger(process.env.SERVER_INACTIVITY_TIMEOUT_MS, 120_000);
  server.maxRequestsPerSocket = positiveInteger(process.env.SERVER_MAX_REQUESTS_PER_SOCKET, 1_000);
  server.maxConnections = positiveInteger(process.env.SERVER_MAX_CONNECTIONS, 1_000);
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });

  return server;
};
