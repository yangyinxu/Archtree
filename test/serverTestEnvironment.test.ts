import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { devNull, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serverTestEnvironment, syntheticServerTestEnvironment } from '../scripts/lib/server-test-environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const probe = fileURLToPath(new URL('./support/dotenvIsolationProbe.ts', import.meta.url));
const tsx = pathToFileURL(createRequire(join(root, 'package.json')).resolve('tsx')).href;
const sentinelKeys = ['ARCHTREE_DOTENV_SENTINEL', 'DB_NAME', 'JWT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'MAX_AUDIO_UPLOAD_MB'];
const sentinelDotenv = [
  'ARCHTREE_DOTENV_SENTINEL=lorem-ipsum-dotenv-sentinel',
  'DB_NAME=dotenv-sentinel-database',
  'JWT_SECRET=dotenv-sentinel-jwt-secret',
  'AWS_SECRET_ACCESS_KEY=dotenv-sentinel-secret-key',
  'MAX_AUDIO_UPLOAD_MB=7',
  ''
].join('\n');

/** The caller's environment without the runner protections under test, so only the builder can add them. */
const unprotectedEnvironment = () => {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const key of ['DOTENV_CONFIG_PATH', ...sentinelKeys, ...Object.keys(syntheticServerTestEnvironment)]) {
    delete environment[key];
  }
  return environment;
};

/** Runs the probe the way a test file runs: tsx-loaded TypeScript with the given cwd and environment. */
const runProbe = (cwd: string, env: NodeJS.ProcessEnv) => {
  const result = spawnSync(process.execPath, ['--import', tsx, probe], {
    cwd, env, encoding: 'utf8', timeout: 60_000, windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { leaked: string[]; missingVariables: string[]; maxAudioUploadMb: number };
};

test('server test environment replaces inherited credentials with loopback values and disables dotenv', () => {
  const inherited = {
    PATH: '/usr/bin', MONGOD_BINARY: '/opt/lorem/mongod', DOTENV_CONFIG_PATH: '/lorem/ipsum/.env',
    DB_CONN_STRING: 'mongodb+srv://lorem:ipsum@cluster.example.invalid/', JWT_SECRET: 'lorem-inherited-secret',
    AWS_SESSION_TOKEN: 'lorem-inherited-session'
  };
  const environment = serverTestEnvironment(inherited);
  assert.equal(environment.DOTENV_CONFIG_PATH, devNull);
  for (const [key, value] of Object.entries(syntheticServerTestEnvironment)) assert.equal(environment[key], value);
  assert.equal(new URL(environment.DB_CONN_STRING!).hostname, '127.0.0.1');
  assert.equal(new URL(environment.AWS_ENDPOINT_URL!).hostname, '127.0.0.1');
  assert.equal(Object.hasOwn(environment, 'AWS_SESSION_TOKEN'), false);
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.MONGOD_BINARY, '/opt/lorem/mongod');
  assert.equal(inherited.JWT_SECRET, 'lorem-inherited-secret');
  assert.equal(inherited.AWS_SESSION_TOKEN, 'lorem-inherited-session');
});

test('test processes cannot see values from a .env in their working directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'archtree-dotenv-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.env'), sentinelDotenv);

  // Control: without the runner environment the probe's own dotenv import exposes the sentinels.
  const exposed = runProbe(directory, unprotectedEnvironment());
  assert.deepEqual(exposed.leaked, ['ARCHTREE_DOTENV_SENTINEL', 'AWS_SECRET_ACCESS_KEY', 'JWT_SECRET']);
  assert.equal(exposed.maxAudioUploadMb, 7);

  const isolated = runProbe(directory, serverTestEnvironment(unprotectedEnvironment()));
  assert.deepEqual(isolated.leaked, []);
  assert.deepEqual(isolated.missingVariables, ['DB_CONN_STRING', 'DB_NAME']);
  assert.equal(isolated.maxAudioUploadMb, 512);
});

test('application modules never load .env; only the server entry module may', () => {
  const loader = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]dotenv(?:\/[\w./-]+)?['"]/;
  const loaders = (directory: string) => readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.[cm]?[jt]s$/.test(file) && loader.test(readFileSync(join(directory, file), 'utf8')))
    .map(file => file.split(sep).join('/'))
    .sort();
  assert.deepEqual(loaders(join(root, 'src')), ['config/entryEnvironment.ts']);
  assert.deepEqual(loaders(join(root, 'scripts', 'lib')), []);
});
