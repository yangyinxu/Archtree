import { defineConfig, devices } from '@playwright/test';

/**
 * One fixture scenario: `spec` names the file when several scenarios split one
 * spec, and `grep` selects the single test that scenario's process serves.
 */
type SocialSuite = { name: string; port: number; spec?: string; grep?: RegExp };
type SocialBrowserSuite = SocialSuite & { browser: 'chromium' | 'firefox' | 'webkit' };

// Each test owns one fixture process, so one test's requests cannot spend another's per-IP or per-account rate windows.
// Ports 4187/4188 belong to the separate room soak configuration. 4190 is a Fetch-blocked port, so room-lifecycle uses 4191.
const roomsRecovery = { name: 'rooms-recovery', port: 4189, spec: 'rooms',
  grep: /real room command races, controller recovery and running host transfer/ } satisfies SocialSuite;
const suites: SocialSuite[] = [{ name: 'rooms', port: 4175, grep: /real social route continues background audio/ }, roomsRecovery,
  { name: 'invitations', port: 4176 }, { name: 'song-requests', port: 4177 }, { name: 'music-shares', port: 4178 },
  { name: 'room-interactions', port: 4179 }, { name: 'listening-status', port: 4180 },
  { name: 'catalog-room', port: 4181 }, { name: 'audio-formats', port: 4182 }, { name: 'room-lifecycle', port: 4191 },
  { name: 'social-without-rooms', port: 4192 },
  // Both safety flows change the same provisioned friendships, so each runs against its own fresh fixture.
  { name: 'social-safety', port: 4193, spec: 'social-safety', grep: /friend requests, removal, blocking and deactivation/ },
  { name: 'room-membership', port: 4194, spec: 'social-safety', grep: /room members are removed, leave, reconnect/ }];

/**
 * Cross-engine audio drift projects held out of the blocking gate. Firefox and WebKit with real Linux decoders
 * intermittently miss the synchronization, seek-generation or playing-element checks in audio-formats.spec.ts.
 * Rooms stay disabled in production until these return to the gate (docs/deployment/social-rollout-runbook.md).
 * CI still runs them in a separate non-blocking step with retained evidence: npm run test:e2e:social:quarantined.
 */
export const quarantinedSocialProjects: readonly string[] = ['firefox-audio-formats', 'webkit-audio-formats'];
/** `gate` is the blocking release selection; `quarantined` selects only the projects listed above. */
export type SocialSelection = 'gate' | 'quarantined';

/** Limit hardware-audio engines to isolated Linux CI and the two critical real-media scenarios. */
export const socialBrowserSuites = (platform: NodeJS.Platform, ci: string | undefined,
  selection: SocialSelection = 'gate'): SocialBrowserSuite[] => [
  ...suites.map(suite => ({ ...suite, browser: 'chromium' as const })),
  ...(platform === 'linux' && ['true', '1'].includes(ci ?? '') ? [
    { name: 'audio-formats', port: 4183, browser: 'firefox' as const },
    { name: 'audio-formats', port: 4184, browser: 'webkit' as const },
    // Native Chromium owns tab-visibility/freezing coverage; other engines exercise their own controller recovery.
    { ...roomsRecovery, port: 4185, browser: 'firefox' as const },
    { ...roomsRecovery, port: 4186, browser: 'webkit' as const }
  ] : [])
].filter(suite => quarantinedSocialProjects.includes(`${suite.browser}-${suite.name}`) === (selection === 'quarantined'));
const desktopDevices = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };

/**
 * Opt-in Mongo/S3/WS gate uses real production routes and separate synthetic accounts. Each selection starts only
 * its own fixture processes and keeps its own output directory, so one run never deletes the other's evidence.
 */
export const socialConfig = (selection: SocialSelection, platform: NodeJS.Platform = process.platform, ci = process.env.CI) => {
  const browserSuites = socialBrowserSuites(platform, ci, selection);
  // Playwright treats an empty project list as one default project that would run every social spec unisolated.
  if (!browserSuites.length) {
    throw new Error('The quarantined cross-engine audio projects run only on Linux with CI=1 (real Firefox/WebKit decoders and an isolated audio sink).');
  }
  return defineConfig({
    forbidOnly: Boolean(process.env.CI),
    testDir: './e2e-social', workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
    expect: { timeout: 10_000 }, outputDir: selection === 'gate' ? './test-results/social-real' : './test-results/social-quarantined', reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4175', headless: true, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    // Each scenario owns a process and stores, including its real IP-rate window; no production limit is reset or relaxed.
    webServer: browserSuites.map(({ name, port }) => ({ command: 'npx --no-install tsx e2e-social/support/serveSocialRooms.ts',
      env: { FINITUDE_SOCIAL_E2E_PORT: String(port), FINITUDE_SOCIAL_E2E_SCENARIO: name },
      url: `http://127.0.0.1:${port}/finitude/social`, reuseExistingServer: false, timeout: 60_000 })),
    projects: browserSuites.map(({ name, port, browser, spec, grep }) => ({ name: `${browser}-${name}`, testMatch: `${spec ?? name}.spec.ts`,
      ...(grep ? { grep } : {}),
      use: { ...desktopDevices[browser], baseURL: `http://127.0.0.1:${port}`,
        // Muting alone can still open an audio device and trigger Bluetooth headphone switching.
        ...(browser === 'chromium' ? { launchOptions: { args: ['--disable-audio-output'] } } : {}) } }))
  });
};

export default socialConfig('gate');
