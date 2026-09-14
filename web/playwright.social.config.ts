import { defineConfig, devices } from '@playwright/test';

const suites = [{ name: 'rooms', port: 4175 }, { name: 'invitations', port: 4176 }] as const;

/** Opt-in Mongo/S3/WS gate uses real production routes and separate synthetic accounts. */
export default defineConfig({
  testDir: './e2e-social', workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  expect: { timeout: 10_000 }, outputDir: './test-results/social-real', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure',
    // Muting alone can still open an audio device and trigger Bluetooth headphone switching.
    launchOptions: { args: ['--disable-audio-output'] } },
  // Each scenario owns a process and stores, including its real IP-rate window; no production limit is reset or relaxed.
  webServer: suites.map(({ port }) => ({ command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
    env: { FINITUDE_SOCIAL_E2E_PORT: String(port) },
    url: `http://127.0.0.1:${port}/finitude/social`, reuseExistingServer: false, timeout: 60_000 })),
  projects: suites.map(({ name, port }) => ({ name: `chromium-${name}`, testMatch: `${name}.spec.ts`,
    use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${port}` } }))
});
