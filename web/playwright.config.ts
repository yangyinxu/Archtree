import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = 4173;
const origin = `http://127.0.0.1:${port}`;
const configDirectory = fileURLToPath(new URL('.', import.meta.url));
// Firefox/WebKit have no verified hardware-free output sink on macOS; headless is not audio isolation.
const includeHardwareAudioBrowsers = process.platform !== 'darwin'
  || process.env.FINITUDE_E2E_ALLOW_HARDWARE_AUDIO === '1';
if (!includeHardwareAudioBrowsers) {
  console.warn('macOS E2E: Firefox/WebKit are excluded to avoid taking over audio devices. '
    + 'Run the full matrix in isolated Linux CI, or explicitly set FINITUDE_E2E_ALLOW_HARDWARE_AUDIO=1.');
}

/** Runs the built listener through Express so browser tests include production routing and CSP. */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{platform}/{arg}{ext}',
  fullyParallel: false,
  failOnFlakyTests: Boolean(process.env.CI),
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
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Fake output preserves real playback without opening the user's audio device, even when headed.
        launchOptions: { args: ['--disable-audio-output'] }
      }
    },
    ...(includeHardwareAudioBrowsers ? [{
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }] : [])
  ]
});
