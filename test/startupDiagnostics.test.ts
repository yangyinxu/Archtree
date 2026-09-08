import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient, MongoNetworkError, MongoParseError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { connectToDatabase, getDb } from '../src/infrastructure/database';
import { DatabaseCollectionInitializationError, DatabaseIndexInitializationError } from '../src/infrastructure/databaseIndexes';
import { DatabaseTopologyUnavailableError } from '../src/infrastructure/databaseTopology';
import {
  createStartupFailureDiagnostic, MissingStartupConfigurationError, recordStartupFailureStage, type StartupStage
} from '../src/infrastructure/startupDiagnostics';

test('startup diagnostics map known failures without serializing secret-bearing error fields', () => {
  const secret = 'synthetic-private-uri-token-email';
  const cases: [unknown, StartupStage, string][] = [
    [new MissingStartupConfigurationError(['DB_CONN_STRING', 'DB_NAME']), 'configuration', 'configuration_missing'],
    [new MongoParseError(secret), 'configuration', 'database_configuration_invalid'],
    [new MongoServerError({ code: 18, errmsg: secret }), 'database_connection', 'database_authentication_failed'],
    [new MongoServerError({ code: 13, errmsg: secret }), 'database_connection', 'database_authentication_failed'],
    [new MongoNetworkError(secret), 'database_connection', 'database_connection_unavailable'],
    [new MongoServerSelectionError(secret, {} as never), 'database_connection', 'database_connection_unavailable'],
    [new DatabaseTopologyUnavailableError(), 'database_topology', 'database_topology_unavailable'],
    [new DatabaseCollectionInitializationError(), 'database_initialization', 'database_collection_unavailable'],
    [new DatabaseIndexInitializationError(secret), 'database_initialization', 'database_index_unavailable'],
    [new Error(secret), 'database_initialization', 'database_initialization_failed'],
    [new Error(secret), 'application', 'application_initialization_failed'],
    [new Error(secret), 'listener_configuration', 'listener_configuration_invalid'],
    [Object.assign(new Error(secret), { code: 'EADDRINUSE' }), 'listener', 'listener_address_in_use'],
    [Object.assign(new Error(secret), { code: 'EACCES' }), 'listener', 'listener_permission_denied'],
    [new Error(secret), 'listener', 'listener_failed']
  ];
  for (const [error, stage, reason] of cases) {
    Object.assign(error as object, { password: secret, uri: secret, stack: secret, cause: secret,
      action: secret, stage: secret, toJSON: () => ({ secret }) });
    const annotated = recordStartupFailureStage(error, stage);
    assert.equal(annotated, error);
    const result = createStartupFailureDiagnostic(annotated);
    assert.equal(result.category, 'server_start_failed');
    assert.equal(result.stage, stage);
    assert.equal(result.reason, reason);
    assert.ok(result.action.length > 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('diagnostics ignore spoofed payloads and preserve the innermost stage', () => {
  const error = new Error('synthetic-private');
  recordStartupFailureStage(error, 'database_topology');
  recordStartupFailureStage(error, 'database_connection');
  assert.equal(createStartupFailureDiagnostic(error).stage, 'database_topology');
  for (const unknown of [
    'synthetic-private', null, { reason: 'synthetic-private', stage: 'synthetic-private', code: 'database_index_unavailable' },
    new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private'); } })
  ]) {
    const result = createStartupFailureDiagnostic(unknown);
    assert.equal(result.reason, 'module_load_failed');
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  }
  const missing = new MissingStartupConfigurationError(['DB_NAME', 'synthetic-private'] as never);
  assert.deepEqual(createStartupFailureDiagnostic(missing).missingVariables, ['DB_NAME']);
});

test('missing database configuration reports every absent name before connecting', async t => {
  const savedUri = process.env.DB_CONN_STRING;
  const savedName = process.env.DB_NAME;
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  let connections = 0;
  t.mock.method(MongoClient.prototype, 'connect', async () => { connections++; throw new Error('must not connect'); });
  try {
    for (const [uri, name, expected] of [
      ['', ' ', ['DB_CONN_STRING', 'DB_NAME']],
      ['mongodb://127.0.0.1:1', '', ['DB_NAME']],
      ['', 'synthetic', ['DB_CONN_STRING']]
    ] as const) {
      process.env.DB_CONN_STRING = uri;
      process.env.DB_NAME = name;
      await assert.rejects(connectToDatabase(), error => {
        assert.ok(error instanceof MissingStartupConfigurationError);
        assert.deepEqual(createStartupFailureDiagnostic(error).missingVariables, expected);
        assert.equal(createStartupFailureDiagnostic(error).stage, 'configuration');
        return true;
      });
    }
    assert.equal(connections, 0);
    assert.equal(getDb(), null);
  } finally {
    if (savedUri === undefined) delete process.env.DB_CONN_STRING; else process.env.DB_CONN_STRING = savedUri;
    if (savedName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = savedName;
  }
});

test('real app entry exits once with actionable missing-variable diagnostics and no dotenv or network access', () => {
  const preload = fileURLToPath(new URL('./support/startupEntrypointPreload.cjs', import.meta.url));
  const entry = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'develop', DB_CONN_STRING: '', DB_NAME: '',
    JWT_SECRET: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
    AWS_EC2_METADATA_DISABLED: 'true', STARTUP_PRIVATE_SENTINEL: 'synthetic-private-env-value' };
  const result = spawnSync(process.execPath, ['--require', preload, tsx, '--require', preload, entry], {
    env, encoding: 'utf8', timeout: 15_000, windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), '');
  const lines = result.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const diagnostic = JSON.parse(lines[0]);
  assert.equal(diagnostic.category, 'server_start_failed');
  assert.equal(diagnostic.stage, 'configuration');
  assert.equal(diagnostic.reason, 'configuration_missing');
  assert.deepEqual(diagnostic.missingVariables, ['DB_CONN_STRING', 'DB_NAME']);
  assert.ok(diagnostic.action.includes('Set the listed variables'));
  assert.ok(Number.isFinite(Date.parse(diagnostic.occurredAt)));
  assert.equal(JSON.stringify(diagnostic).includes('synthetic-private-env-value'), false);
  assert.deepEqual(Object.keys(diagnostic).sort(), ['action', 'category', 'missingVariables', 'occurredAt', 'reason', 'stage']);
});
