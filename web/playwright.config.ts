import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = 4173;
const origin = `http://127.0.0.1:${port}`;
const configDirectory = fileURLToPath(new URL('.', import.meta.url));
/**
 * All workers share one test server; as 127.0.0.1 they would spend one per-IP rate window (public
 * reads allow 120 a minute) and a late request, such as a locale bundle, would get 429. Each worker
 * instead forwards its own RFC 2544 benchmark address through the one trusted proxy hop, as
 * production clients do; no limit is reset or relaxed. Workers reload this file with their index set.
 */
const workerClientAddress = `198.18.0.${Number(process.env.TEST_PARALLEL_INDEX ?? 0) + 1}`;

/** Runs the built listener through Express so browser tests include production routing and CSP. */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{platform}/{arg}{ext}',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI
    ? [
        ['line'],
        ['junit', { outputFile: './test-results/e2e-junit.xml' }],
        ['html', { outputFolder: './playwright-report', open: 'never' }]
      ]
    : [
        ['list'],
        ['html', { outputFolder: './playwright-report', open: 'never' }]
      ],
  use: {
    baseURL: origin,
    extraHTTPHeaders: { 'X-Forwarded-For': workerClientAddress },
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'npx --no-install tsx e2e/support/serveBuiltApp.ts',
    cwd: configDirectory,
    reuseExistingServer: false,
    timeout: 30_000,
    url: `${origin}/finitude`
  },
  // Chromium only: Firefox/WebKit real-audio runs on Linux CI were the main source of flaky failures.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Fake output preserves real playback without opening the user's audio device, even when headed.
        launchOptions: { args: ['--disable-audio-output'] }
      }
    }
  ]
});
