import { defineConfig, devices } from '@playwright/test';

const suites = [{ name: 'rooms', port: 4175 }, { name: 'invitations', port: 4176 },
  { name: 'song-requests', port: 4177 }, { name: 'music-shares', port: 4178 },
  { name: 'room-interactions', port: 4179 }, { name: 'listening-status', port: 4180 },
  { name: 'catalog-room', port: 4181 }, { name: 'audio-formats', port: 4182 }] as const;

/** Limit hardware-audio engines to isolated Linux CI and the two critical real-media scenarios. */
export const socialBrowserSuites = (platform: NodeJS.Platform, ci: string | undefined) => [
  ...suites.map(suite => ({ ...suite, browser: 'chromium' as const })),
  ...(platform === 'linux' && ['true', '1'].includes(ci ?? '') ? [
    { name: 'audio-formats', port: 4183, browser: 'firefox' as const },
    { name: 'audio-formats', port: 4184, browser: 'webkit' as const },
    { name: 'rooms', port: 4185, browser: 'firefox' as const },
    { name: 'rooms', port: 4186, browser: 'webkit' as const }
  ] : [])
];
const browserSuites = socialBrowserSuites(process.platform, process.env.CI);
const desktopDevices = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };

/** Opt-in Mongo/S3/WS gate uses real production routes and separate synthetic accounts. */
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: './e2e-social', workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  expect: { timeout: 10_000 }, outputDir: './test-results/social-real', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Each scenario owns a process and stores, including its real IP-rate window; no production limit is reset or relaxed.
  webServer: browserSuites.map(({ name, port }) => ({ command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
    env: { FINITUDE_SOCIAL_E2E_PORT: String(port), FINITUDE_SOCIAL_E2E_SCENARIO: name },
    url: `http://127.0.0.1:${port}/finitude/social`, reuseExistingServer: false, timeout: 60_000 })),
  projects: browserSuites.map(({ name, port, browser }) => ({ name: `${browser}-${name}`, testMatch: `${name}.spec.ts`,
    // Native Chromium owns tab-visibility/freezing coverage; other engines exercise their own controller recovery.
    ...(name === 'rooms' && browser !== 'chromium' ? { grep: /controller recovery and running host transfer/ } : {}),
    use: { ...desktopDevices[browser], baseURL: `http://127.0.0.1:${port}`,
      // Muting alone can still open an audio device and trigger Bluetooth headphone switching.
      ...(browser === 'chromium' ? { launchOptions: { args: ['--disable-audio-output'] } } : {}) } }))
});
