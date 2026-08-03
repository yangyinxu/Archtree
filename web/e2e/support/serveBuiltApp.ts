import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.FINITUDE_E2E_PORT ?? 4173);
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const listenerDistPath = path.join(webRoot, 'dist');
const isolatedEnvironmentPath = fileURLToPath(new URL('./empty.env', import.meta.url));

/** Removes inherited application credentials before importing the Express graph. */
const isolateEnvironment = () => {
  const exactKeys = new Set([
    'AUTH_CODE_PEPPER',
    'AUTH_EMAIL_FROM',
    'DB_CONN_STRING',
    'DB_NAME',
    'JWT_SECRET',
    'S3_BUCKET_NAME'
  ]);
  const prefixes = ['AWS_', 'DB_', 'S3_'];

  for (const key of Object.keys(process.env)) {
    if (exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }

  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = isolatedEnvironmentPath;
  process.env.JWT_SECRET = 'finitude-browser-test-only';
  process.env.AUTH_CODE_PEPPER = 'finitude-browser-test-only';
};

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('FINITUDE_E2E_PORT must be a valid TCP port.');
}
if (!existsSync(path.join(listenerDistPath, 'index.html'))) {
  throw new Error('web/dist is missing. Build the listener before running Playwright.');
}

isolateEnvironment();

// Dynamic import ensures dotenv/config sees only the isolated test environment.
const { createApp } = await import('../../../src/app');
const app = createApp({ environment: 'test', listenerDistPath });
const server = await new Promise<Server>((resolve, reject) => {
  const listening = app.listen(port, host, () => resolve(listening));
  listening.once('error', reject);
});

console.log(`Finitude browser-test server listening at http://${host}:${port}/listen`);

/** Lets Playwright stop the isolated server without leaving an occupied port. */
const shutdown = () => {
  server.close((error) => {
    if (error) {
      console.error('Unable to close the Finitude browser-test server.', error);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
