import { spawn } from 'node:child_process';
import { globSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLinuxRuntime, assertMongoRuntime, assertNodeRuntime } from './check-runtime.mjs';
import { serverTestArguments } from './lib/server-test-arguments.mjs';
import { serverTestEnvironment } from './lib/server-test-environment.mjs';
import { serverTestProgressArguments, serverTestStallMs, watchServerTests } from './lib/server-test-watchdog.mjs';

/** Expands test paths consistently without depending on shell glob support. */
const run = () => {
  assertNodeRuntime();
  const mode = process.argv[2] || 'unit';
  if (!['unit', 'linux', 'integration'].includes(mode)) throw new Error('Expected unit, linux, or integration test mode.');
  if (mode === 'linux') assertLinuxRuntime();
  if (mode === 'integration') assertMongoRuntime();
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pattern = mode === 'integration' ? 'test/**/*.integration.ts' : 'test/**/*.test.ts';
  const candidates = globSync(pattern, { cwd: root }).sort();
  const files = candidates.filter(file => {
    const linuxOnly = file.endsWith('.linux.test.ts');
    return mode === 'linux' ? linuxOnly : process.platform === 'linux' || !linuxOnly;
  });
  if (!files.length) throw new Error(`No ${mode} test files found.`);
  const excluded = candidates.filter(file => !files.includes(file));
  if (mode === 'unit' && excluded.length) {
    console.log(`Linux release suites are separate on ${process.platform}: ${excluded.join(', ')}. CI runs these with npm run test:server:linux.`);
  }
  const forwarded = process.argv.slice(3);
  const stallMs = serverTestStallMs(forwarded);
  const progressDirectory = stallMs && mkdtempSync(path.join(tmpdir(), 'archtree-server-tests-'));
  const progressPath = progressDirectory && path.join(progressDirectory, 'progress.jsonl');
  // The watchdog's reporters travel in the forwarded slot, which serverTestArguments places before the file list.
  const reporters = progressPath ? serverTestProgressArguments(progressPath) : [];
  // Every mode gets the isolated environment: tests run from the root, next to any private .env.
  const child = spawn(process.execPath, serverTestArguments(mode, [...reporters, ...forwarded], files),
    { cwd: root, env: serverTestEnvironment(process.env), stdio: 'inherit', windowsHide: true });
  const watchdog = progressPath && watchServerTests({ runner: child, progressPath, stallMs });
  const finish = () => {
    watchdog?.stop();
    if (progressDirectory) rmSync(progressDirectory, { recursive: true, force: true });
  };
  // An interrupted run waits for the runner to stop, so finish() still removes the progress directory; a second
  // signal ends this process at once.
  if (progressDirectory) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', () => { finish(); console.error('Could not start the test runner. Run npm ci and retry.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { finish(); process.exitCode = watchdog?.stalled ? 1 : code ?? (signal ? 1 : 0); });
};

try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
