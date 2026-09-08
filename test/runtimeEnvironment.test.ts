import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLinuxRuntime, assertNodeRuntime } from '../scripts/check-runtime.mjs';

test('runtime preflight rejects unsupported Node majors with an actionable message', () => {
  assert.doesNotThrow(() => assertNodeRuntime('24.20.0'));
  for (const version of ['22.0.0', '26.7.0', 'invalid']) {
    assert.throws(() => assertNodeRuntime(version), /requires Node.js 24.x/);
  }
});

test('release preflight cannot silently pass outside Linux', () => {
  assert.throws(() => assertLinuxRuntime('win32'), /requires Linux/);
  assert.throws(() => assertLinuxRuntime('darwin'), /requires Linux/);
});

test('integration runner fails once before loading suites when mongod is missing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'archtree-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/run-server-tests.mjs', 'integration'], {
    env: { ...process.env, MONGOD_BINARY: join(directory, 'missing-mongod') },
    encoding: 'utf8', timeout: 15_000, windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MongoDB test daemon is unavailable/);
  assert.doesNotMatch(result.stdout, /Subtest|TAP version|DB_CONN_STRING/);
  assert.equal((result.stderr.match(/MongoDB test daemon is unavailable/g) || []).length, 1);
});

test('startup environment assignments work without shell-specific syntax', () => {
  const executable = fileURLToPath(new URL('../node_modules/cross-env/dist/bin/cross-env.js', import.meta.url));
  const result = spawnSync(process.execPath, [executable, 'NODE_ENV=develop', 'ACCESS_TOKEN_SECONDS=5',
    process.execPath, '-p', 'JSON.stringify([process.env.NODE_ENV,process.env.ACCESS_TOKEN_SECONDS])'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['develop', '5']);
});
