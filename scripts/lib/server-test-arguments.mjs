/**
 * node:test has no default timeout, so one test awaiting a lost callback would stall the whole gate.
 * The slowest current server test takes seconds; this bound only turns a hang into a failure.
 */
export const defaultServerTestTimeoutMs = 120_000;

/** Builds node:test arguments; an explicit --test-timeout argument takes precedence over the default. */
export const serverTestArguments = (mode, forwarded, files) => [
  '--import', 'tsx', '--test',
  ...(mode === 'integration' ? ['--test-concurrency=1'] : []),
  ...(forwarded.some(argument => argument.startsWith('--test-timeout'))
    ? [] : [`--test-timeout=${defaultServerTestTimeoutMs}`]),
  ...forwarded, ...files
];
