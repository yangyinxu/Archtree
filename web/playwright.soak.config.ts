import { defineConfig, devices } from '@playwright/test';
import { readRoomSoakOptions } from './e2e-social/support/roomSoakPolicy';
import { randomUUID } from 'node:crypto';

const options = readRoomSoakOptions();
const controlToken = randomUUID();

/** A separate, bounded longevity gate keeps ordinary release CI fast and hardware audio closed. */
export default defineConfig({
  testDir: './e2e-social/soak', fullyParallel: false, workers: 1, retries: 0,
  // Cold admission, a final Retry-After window, and owned teardown sit outside timed playback.
  forbidOnly: Boolean(process.env.CI), timeout: (options.durationSeconds + 300) * 1000,
  expect: { timeout: 15_000 }, reporter: 'list', outputDir: './test-results/room-soak',
  globalTeardown: './e2e-social/support/stopRoomSoakFixture.ts',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4187', headless: true,
    actionTimeout: 15_000, trace: 'off', screenshot: 'only-on-failure',
    launchOptions: { args: ['--disable-audio-output'] } },
  webServer: { command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
    env: { FINITUDE_SOCIAL_E2E_PORT: '4187', FINITUDE_SOCIAL_E2E_SCENARIO: 'soak', FINITUDE_ROOM_SOAK_STOP_TOKEN: controlToken },
    url: 'http://127.0.0.1:4187/finitude/social', reuseExistingServer: false, timeout: 90_000 },
  projects: [{ name: 'chromium-room-soak' }]
});
