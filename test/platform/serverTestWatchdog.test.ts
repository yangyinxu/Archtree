/**
 * The server test watchdog against the hangs node:test cannot bound: a test file's process blocked before its first
 * test, and one blocked while exiting after its tests passed. Each case runs a nested `node --test --test-force-exit`
 * with the progress reporter on synthetic files and watches it as the server test runner watches the suite.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { defaultServerTestTimeoutMs } from '../../scripts/lib/server-test-arguments.mjs';
import { serverTestProgressArguments, serverTestProgressReporter, serverTestStallMs, watchServerTests } from '../../scripts/lib/server-test-watchdog.mjs';

const unwatched = serverTestStallMs([]) === null && 'the watchdog runs on POSIX hosts with Node 24.20.0 or later';
const directory = mkdtempSync(path.join(tmpdir(), 'archtree-test-watchdog-'));
after(() => rmSync(directory, { recursive: true, force: true }));

const fixture = (name: string, source: string) => writeFileSync(path.join(directory, name), `import { test } from 'node:test';\n${source}\n`);
// Bounded, so a fixture outlives a failed run by a minute at most instead of blocking forever.
const block = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);';
fixture('a-fast.test.mjs', `test('a fast file passes', () => {});`);
fixture('b-exit.test.mjs', `test('passes, then its process never finishes exiting', () => { process.once('exit', () => { ${block} }); });`);
fixture('c-load.test.mjs', `${block}\ntest('never registered', () => {});`);
fixture('d-later.test.mjs', `test('a later file finishes while earlier ones are stuck', () => {});`);

/** Runs files under a nested runner outside any test context, watched with the given bound. */
function runWatched(files: string[], stallMs: number) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const progressPath = path.join(directory, `${files.join('-')}.jsonl`);
    const reporter = pathToFileURL(path.resolve(serverTestProgressReporter)).href;
    const args = ['--test', '--test-force-exit', '--test-concurrency=4', ...serverTestProgressArguments(progressPath, reporter), ...files];
    const started = Date.now();
    return new Promise<{ code: number | null; stalled: boolean; output: string; log: string; seconds: number }>((resolve, reject) => {
        const runner = spawn(process.execPath, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
        const lines: string[] = [];
        const watchdog = watchServerTests({ runner, progressPath, stallMs, pollMs: 250, log: line => lines.push(line) });
        let output = '';
        runner.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        runner.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
        runner.once('error', reject);
        runner.once('close', code => {
            watchdog.stop();
            resolve({ code, stalled: watchdog.stalled, output, log: lines.join('\n'), seconds: (Date.now() - started) / 1_000 });
        });
    });
}

test('the stall bound follows --test-timeout, and debugger sessions, own reporters, Windows and older Node run unwatched', () => {
    const node = '24.20.0';
    assert.equal(serverTestStallMs([], 'linux', node), defaultServerTestTimeoutMs + 60_000);
    assert.equal(serverTestStallMs(['--test-timeout=600000'], 'linux', node), 660_000);
    assert.equal(serverTestStallMs(['--test-timeout', '30000'], 'darwin', node), 90_000);
    assert.equal(serverTestStallMs(['--test-timeout=0'], 'linux', node), null);
    assert.equal(serverTestStallMs(['--inspect-brk'], 'linux', node), null);
    assert.equal(serverTestStallMs(['--test-reporter=tap'], 'linux', node), null);
    assert.equal(serverTestStallMs([], 'win32', node), null);
    assert.equal(serverTestStallMs([], 'linux', '24.19.1'), null);
    assert.equal(serverTestStallMs([], 'darwin', '25.1.0'), defaultServerTestTimeoutMs + 60_000);
    assert.deepEqual(serverTestProgressArguments('progress.jsonl'), ['--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${serverTestProgressReporter}`, '--test-reporter-destination=progress.jsonl']);
});

test('a healthy watched run passes with no watchdog report', { skip: unwatched }, async () => {
    const run = await runWatched(['a-fast.test.mjs', 'd-later.test.mjs'], 15_000);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.stalled, false);
    assert.equal(run.log, '');
});

test('files stuck before their first test or while exiting fail by name, and every held result is still printed', { skip: unwatched }, async () => {
    const run = await runWatched(['a-fast.test.mjs', 'b-exit.test.mjs', 'c-load.test.mjs', 'd-later.test.mjs'], 3_000);
    assert.equal(run.code, 1, run.output);
    assert.equal(run.stalled, true);
    assert.ok(run.seconds < 30, `${run.seconds} s`);
    assert.match(run.log, /Server test file stalled: .*b-exit\.test\.mjs \(running \d+ s, reported tests finished: 1, silent \d+ s since "passes, then its process never finishes exiting" finished\)/);
    assert.match(run.log, /c-load\.test\.mjs \(running \d+ s, reported tests finished: 0, silent \d+ s since its process started\)/);
    assert.match(run.log, /^\d+ ppid=\d+ \S+ \S+ .* c-load\.test\.mjs$/m);
    if (process.platform === 'linux') assert.match(run.log, /^ {2}thread \d+ .+ state=S wchan=/m);
    for (const name of ['a fast file passes', 'passes, then its process never finishes exiting', 'a later file finishes while earlier ones are stuck']) {
        assert.match(run.output, new RegExp(`✔ ${name}`));
    }
    assert.match(run.output, /✖ b-exit\.test\.mjs/);
    assert.match(run.output, /✖ c-load\.test\.mjs/);
});
