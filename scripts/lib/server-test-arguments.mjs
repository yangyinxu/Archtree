/**
 * node:test has no default timeout, so one test awaiting a lost callback would stall the whole gate.
 * The slowest current server test takes seconds; this bound only turns a hang into a failure.
 */
export const defaultServerTestTimeoutMs = 120_000;

/**
 * Builds node:test arguments; an explicit --test-timeout argument takes precedence over the default.
 * --test-timeout cannot end a file whose tests finished but left a handle (socket, timer, child)
 * open, so --test-force-exit ends each file after its tests and hooks complete. A forwarded
 * --no-test-force-exit comes later and wins, which keeps leaked handles diagnosable.
 */
export const serverTestArguments = (mode, forwarded, files) => [
  '--import', 'tsx', '--test', '--test-force-exit',
  ...(mode === 'integration' ? ['--test-concurrency=1'] : []),
  ...(forwarded.some(argument => argument.startsWith('--test-timeout'))
    ? [] : [`--test-timeout=${defaultServerTestTimeoutMs}`]),
  ...forwarded, ...files
];
