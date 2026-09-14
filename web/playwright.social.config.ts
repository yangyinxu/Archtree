import { defineConfig, devices } from '@playwright/test';

/** Opt-in Mongo/S3/WS gate uses real production routes and separate synthetic accounts. */
export default defineConfig({
  testDir: './e2e-social', workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  expect: { timeout: 10_000 }, outputDir: './test-results/social-real', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
    url: 'http://127.0.0.1:4175/finitude/social', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
