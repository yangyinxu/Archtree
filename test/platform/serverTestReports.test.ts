/**
 * The server test runner's report guard under the race it exists for: a node:test runner that is not reading while a
 * test file's process force-exits. Each case runs a nested `node --test --test-force-exit` on a synthetic file of fast
 * synchronous tests whose report outgrows a pipe buffer. That file's process stops the nested runner with SIGSTOP, as a
 * runner starved of CPU stalls, and a helper resumes it once the file's process has exited or after a bound.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { serverTestArguments, testReportGuardPreload } from '../../scripts/lib/server-test-arguments.mjs';

const posixOnly = process.platform === 'win32' && 'SIGSTOP and blocking pipes are POSIX-only';
const fileTests = 36;
const directory = mkdtempSync(path.join(tmpdir(), 'archtree-test-reports-'));
after(() => rmSync(directory, { recursive: true, force: true }));

const fixture = (name: string, source: string) => {
    writeFileSync(path.join(directory, name), source);
    return path.join(directory, name);
};
const burstFile = fixture('burst.test.mjs', `import { test } from 'node:test';
for (let index = 0; index < ${fileTests}; index++) test(\`burst \${index} \${'a fast synchronous test with a long descriptive name '.repeat(4)}\`, () => {});
`);
// Stops the runner that started this file's process; the helper resumes it when its stdin closes, which happens when
// this process exits, or after STALL_LIMIT_MS while this process waits on the stopped runner.
const stallPreload = fixture('stall-runner.mjs', `import { spawn } from 'node:child_process';
if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const resume = "const [runner, limit] = process.argv.slice(1).map(Number); const go = () => { try { process.kill(runner, 'SIGCONT'); } finally { process.exit(); } }; process.stdin.on('end', go).on('close', go).resume(); setTimeout(go, limit);";
  const helper = spawn(process.execPath, ['-e', resume, String(process.ppid), process.env.STALL_LIMIT_MS], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  helper.unref(); helper.stdin.unref();
  process.kill(process.ppid, 'SIGSTOP');
}
`);
// Stands in for a stream the guard cannot make blocking; without backpressure the stopped runner cannot hold the
// file's process back, whatever the pipe's buffer size.
const nonBlockingPreload = fixture('non-blocking-report.mjs', `if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  process.stdout._handle.setBlocking(false);
  process.stdout._writableState.highWaterMark = 1 << 30;
}
`);

/** Runs the burst file under a nested runner with TAP output; the runner is outside any test context. */
function runStalled(preloads: string[], stallLimitMs: number) {
    const env: NodeJS.ProcessEnv = { ...process.env, STALL_LIMIT_MS: String(stallLimitMs) };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const args = [...preloads.flatMap(preload => ['--import', pathToFileURL(preload).href]), '--test', '--test-force-exit', '--test-reporter=tap', burstFile];
    return new Promise<{ code: number | null; output: string; passed: number }>((resolve, reject) => {
        const runner = spawn(process.execPath, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, killSignal: 'SIGKILL' });
        let output = '';
        runner.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        runner.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
        runner.once('error', reject);
        runner.once('close', code => resolve({ code, output, passed: Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? -1) }));
    });
}

test('the runner preloads the report guard, and with it every result reaches a runner that stalls while the file force-exits', { skip: posixOnly }, async () => {
    assert.ok(serverTestArguments('unit', [], []).includes(testReportGuardPreload));
    const run = await runStalled([path.resolve(testReportGuardPreload), stallPreload], 2_000);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.passed, fileTests, run.output);
    assert.match(run.output, /^# fail 0$/m);
});

test('results still queued when a file force-exits fail that file instead of disappearing from a passing run', { skip: posixOnly }, async () => {
    const run = await runStalled([path.resolve(testReportGuardPreload), nonBlockingPreload, stallPreload], 45_000);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /bytes of test results were still queued when this test file's process exited/);
    assert.ok(run.passed < fileTests, run.output);
});
