import { writeSync } from 'node:fs';

/**
 * Preloaded into every server test process by `server-test-arguments.mjs`; it acts only in the process node:test
 * starts for each file (`NODE_TEST_CONTEXT=child-v8`), which sends its results to the runner through a stdout pipe.
 * `--test-force-exit` ends that process with `process.exit()` once its last report chunk has been handed to
 * `process.stdout`, not once the pipe has taken it. The pipe is non-blocking, so whatever its kernel buffer (typically
 * 64 KiB) has not taken stays queued in the process and `process.exit()` discards it: the runner counts fewer tests while
 * the file still exits 0. A file of fast synchronous tests writes its whole report in one burst right before that
 * exit, so a runner too busy to read at that moment lost the file's last results.
 *
 * Blocking writes leave nothing queued: each write returns once the pipe has taken it, and a slow runner only slows
 * the file down. If bytes are still queued at exit anyway (a stream that cannot block), the file fails and says so
 * on stderr instead of passing with results missing.
 */
export const guardTestReports = (target = process) => {
  for (const stream of [target.stdout, target.stderr]) stream._handle?.setBlocking?.(true);
  target.once('exit', () => {
    const queued = target.stdout.writableLength;
    if (queued === 0) return;
    target.exitCode = 1;
    try {
      writeSync(2, `${queued} bytes of test results were still queued when this test file's process exited, so the runner never received them; failing the file instead of passing it with results missing.\n`);
    } catch { /* The exit code still fails the file. */ }
  });
};

if (process.env.NODE_TEST_CONTEXT === 'child-v8') guardTestReports();
