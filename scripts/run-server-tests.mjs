import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertLinuxRuntime, assertMongoRuntime, assertNodeRuntime } from './check-runtime.mjs';

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
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--test',
    ...(mode === 'integration' ? ['--test-concurrency=1'] : []),
    ...process.argv.slice(3), ...files
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', () => { console.error('Could not start the test runner. Run npm ci and retry.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
};

try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
