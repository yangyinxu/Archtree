/**
 * node:test has no default timeout, so one test awaiting a lost callback would stall the whole gate.
 * The slowest current server test takes seconds; this bound only turns a hang into a failure.
 */
export const defaultServerTestTimeoutMs = 120_000;

/** Installs a synthetic MX resolver in every test process, so email-domain checks never query real DNS. */
export const syntheticMxResolverPreload = './test/support/syntheticMxResolver.ts';

/** Keeps --test-force-exit from discarding a file's last results while the runner is slow to read them. */
export const testReportGuardPreload = './scripts/lib/server-test-report-guard.mjs';

/**
 * Builds node:test arguments; an explicit --test-timeout argument takes precedence over the default.
 * --test-timeout cannot end a file whose tests finished but left a handle (socket, timer, child)
 * open, so --test-force-exit ends each file after its tests and hooks complete; the report guard
 * keeps that exit from discarding results the runner has not read yet. A forwarded --no-test-force-exit
 * comes later and wins, which keeps leaked handles diagnosable. Preload paths are relative to the
 * repository root, the runner's working directory.
 */
export const serverTestArguments = (mode, forwarded, files) => [
  '--import', 'tsx', '--import', syntheticMxResolverPreload, '--import', testReportGuardPreload, '--test', '--test-force-exit',
  ...(mode === 'integration' ? ['--test-concurrency=1'] : []),
  ...(forwarded.some(argument => argument.startsWith('--test-timeout'))
    ? [] : [`--test-timeout=${defaultServerTestTimeoutMs}`]),
  ...forwarded, ...files
];
