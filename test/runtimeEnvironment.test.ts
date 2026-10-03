import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLinuxRuntime, assertNodeRuntime, assertRoomAudioRuntime } from '../scripts/check-runtime.mjs';
import { serverTestArguments } from '../scripts/lib/server-test-arguments.mjs';

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

test('server test runs bound each test so a lost callback fails instead of stalling the gate', () => {
  const preload = ['--import', 'tsx', '--import', './test/support/syntheticMxResolver.ts'];
  assert.deepEqual(serverTestArguments('unit', [], ['test/a.test.ts']),
    [...preload, '--test', '--test-force-exit', '--test-timeout=120000', 'test/a.test.ts']);
  assert.deepEqual(serverTestArguments('integration', ['--test-timeout=600000'], ['test/a.integration.ts']),
    [...preload, '--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=600000',
      'test/a.integration.ts']);
  // Node applies the last occurrence, so a forwarded opt-out can expose a leaked handle.
  const diagnostic = serverTestArguments('unit', ['--no-test-force-exit'], ['test/a.test.ts']);
  assert.ok(diagnostic.lastIndexOf('--no-test-force-exit') > diagnostic.indexOf('--test-force-exit'));
});

test('server test runs end a passing file that leaks an open handle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'archtree-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'leaked-handle.test.mjs');
  await writeFile(fixture, [
    "import test from 'node:test';",
    "test('passes but leaves a timer running', () => { setInterval(() => {}, 60_000); });"
  ].join('\n'));
  // Drop the parent runner's context so the nested run reports as a standalone gate.
  const { NODE_TEST_CONTEXT: _parentContext, ...env } = process.env;
  const result = spawnSync(process.execPath, serverTestArguments('unit', [], [fixture]), {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env, encoding: 'utf8', timeout: 30_000, windowsHide: true
  });
  assert.equal(result.error, undefined, 'the leaked handle kept the test runner alive');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\bpass 1\b/);
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


test('room audio preflight requires real codec capabilities and hides unsafe binary diagnostics', () => {
  assert.match(assertRoomAudioRuntime(), /[0-9]/);
  assert.throws(() => assertRoomAudioRuntime('relative/secret-decoder'), error => {
    assert.match(error.message, /Room audio decoder is unavailable/);
    assert.doesNotMatch(error.message, /secret-decoder/);
    return true;
  });
});
