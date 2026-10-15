import { defineConfig, devices } from '@playwright/test';

/**
 * One fixture scenario: `spec` names the file when several scenarios split one
 * spec, and `grep` selects the single test that scenario's process serves.
 */
type SocialSuite = { name: string; port: number; spec?: string; grep?: RegExp };

// Each test owns one fixture process, so one test's requests cannot spend another's per-IP or per-account rate windows.
// 4190 is a Fetch-blocked port, so room-lifecycle uses 4191.
const suites: SocialSuite[] = [{ name: 'rooms', port: 4175, grep: /real social route continues background audio/ },
  { name: 'rooms-recovery', port: 4189, spec: 'rooms', grep: /real room command races, controller recovery and running host transfer/ },
  { name: 'invitations', port: 4176 }, { name: 'song-requests', port: 4177 }, { name: 'music-shares', port: 4178 },
  { name: 'room-interactions', port: 4179 }, { name: 'listening-status', port: 4180 },
  { name: 'catalog-room', port: 4181 }, { name: 'audio-formats', port: 4182 }, { name: 'room-lifecycle', port: 4191 },
  { name: 'social-without-rooms', port: 4192 },
  // Both safety flows change the same provisioned friendships, so each runs against its own fresh fixture.
  { name: 'social-safety', port: 4193, spec: 'social-safety', grep: /friend requests, removal, blocking and deactivation/ },
  { name: 'room-membership', port: 4194, spec: 'social-safety', grep: /room members are removed, leave, reconnect/ }];

/** Real Mongo/S3/WS routes with separate synthetic accounts, exercised in Chromium only. */
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: './e2e-social', workers: 1, fullyParallel: false, retries: process.env.CI ? 1 : 0, timeout: 120_000,
  expect: { timeout: 10_000 }, outputDir: './test-results/social-real', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Each scenario owns a process and stores, including its real IP-rate window; no production limit is reset or relaxed.
  webServer: suites.map(({ name, port }) => ({ command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
    env: { FINITUDE_SOCIAL_E2E_PORT: String(port), FINITUDE_SOCIAL_E2E_SCENARIO: name },
    url: `http://127.0.0.1:${port}/finitude/social`, reuseExistingServer: false, timeout: 60_000 })),
  projects: suites.map(({ name, port, spec, grep }) => ({ name: `chromium-${name}`, testMatch: `${spec ?? name}.spec.ts`,
    ...(grep ? { grep } : {}),
    use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${port}`,
      // Muting alone can still open an audio device and trigger Bluetooth headphone switching.
      launchOptions: { args: ['--disable-audio-output'] } } }))
});
