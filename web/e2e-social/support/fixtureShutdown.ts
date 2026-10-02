import { createServer } from 'node:http';

/** A loopback-only control plane lets Windows runners drain owned fixtures before forced process teardown. */
export const startFixtureShutdown = async (port: number, token: string, closeResources: () => Promise<void>) => {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid disposable shutdown capability.');
  let closing = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/stop' || request.headers['x-fixture-stop-token'] !== token) {
      response.writeHead(404).end(); return;
    }
    if (closing) { response.writeHead(409).end(); return; }
    closing = true;
    try {
      await closeResources();
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ cleanupComplete: true }));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ cleanupComplete: false }));
      process.exitCode = 1;
    } finally {
      server.close();
      server.closeIdleConnections();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Disposable control plane failed to bind.');
  return {
    port: address.port,
    // Initiate control-plane drain without awaiting the active request that reports resource cleanup.
    stopAccepting: () => { server.close(); server.closeIdleConnections(); }
  };
};
