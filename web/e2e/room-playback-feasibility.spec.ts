import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { createTestTone } from './fixtures/audio';
import { fulfillMedia } from './support/apiRoutes';
import type {} from './support/roomPlaybackHarness';

let harnessBundle = '';

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./support/roomPlaybackHarness.ts', import.meta.url)),
        name: 'RoomPlaybackProbe', formats: ['iife']
      }
    }
  });
  if (!Array.isArray(output) || output[0].output[0].type !== 'chunk') {
    throw new Error('Expected an in-memory room feasibility bundle.');
  }
  harnessBundle = output[0].output[0].code;
});

test.beforeEach(async ({ page }) => {
  const tone = createTestTone().subarray(0, 44 + 2 * 8000 * 2);
  tone.writeUInt32LE(tone.length - 8, 4);
  tone.writeUInt32LE(tone.length - 44, 40);
  await page.route('**/__room-tone/*.wav', (route) => fulfillMedia(route, tone, 'audio/wav'));
  await page.route('**/__room-probe.js', (route) => route.fulfill({ contentType: 'text/javascript', body: harnessBundle }));
  await page.route('**/__room-probe', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body><script src="/__room-probe.js"></script></body></html>'
  }));
  await page.goto('/__room-probe');
  await page.waitForFunction(() => Boolean(window.roomProbe));
});

test('real audio prepares and seeks without feedback; shared trace keeps one media element', async ({ page }) => {
  await page.evaluate(() => window.roomProbe.apply(0));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'ready'))).toBe(true);
  await page.evaluate(() => window.roomProbe.apply(1));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'ready' && item.entryId === 'entry-b'))).toBe(true);
  const loaded = await page.evaluate(() => window.roomProbe.state().loads);
  expect(await page.evaluate(() => window.roomProbe.apply(2))).toBe(false);
  expect(await page.evaluate(() => window.roomProbe.apply(3))).toBe(true);
  expect(await page.evaluate(() => window.roomProbe.apply(4))).toBe(false);
  await page.evaluate(() => window.roomProbe.apply(5));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'actual-start'))).toBe(true);
  await page.evaluate(() => window.roomProbe.apply(6));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.some((item) => item.type === 'seek-complete' && item.playbackEpoch === 44))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().seeking)).toBe(false);
  const state = await page.evaluate(() => window.roomProbe.state());
  expect(state.currentTime, JSON.stringify(state)).toBeCloseTo(0.5, 1);
  expect(state.loads).toBe(loaded);
  expect(state.creations).toBe(1);
  expect(state.mediaCount).toBe(1);
  expect(state.intents).toEqual([]);
  expect(state.paused).toBe(true);
  await page.evaluate(() => window.roomProbe.destroy());
});

test('real scheduled start, local pause, rate correction and natural end cannot echo commands', async ({ page }) => {
  await page.evaluate(() => window.roomProbe.apply(0));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().readyState)).toBeGreaterThanOrEqual(3);
  const anchor = await page.evaluate(() => performance.now() + 350);
  await page.evaluate((anchorMonotonicMs) => window.roomProbe.apply(5, { anchorMonotonicMs }), anchor);
  expect(await page.evaluate(() => window.roomProbe.state().paused)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().observations.filter((item) => item.type === 'actual-start').length)).toBe(1);
  const actual = await page.evaluate(() => window.roomProbe.state().observations.find((item) => item.type === 'actual-start')!.monotonicMs);
  expect(actual).toBeGreaterThanOrEqual(anchor - 10);
  await page.evaluate(() => window.roomProbe.pauseLocally());
  await page.evaluate(() => window.roomProbe.apply(5, { revision: 10, playbackEpoch: 50 }));
  expect(await page.evaluate(() => window.roomProbe.state().paused)).toBe(true);
  await page.evaluate(() => window.roomProbe.resync());
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().paused)).toBe(false);
  expect(await page.evaluate(() => window.roomProbe.correct((window.roomProbe.state().currentTime ?? 0) + 0.25))).toBe('rate');
  expect(await page.evaluate(() => window.roomProbe.state().rate)).toBe(1.05);
  await page.evaluate(() => window.roomProbe.seekThroughNativeElement(1.8));
  await expect.poll(() => page.evaluate(() => window.roomProbe.state().snapshot.status)).toBe('ended');
  const ended = await page.evaluate(() => window.roomProbe.state());
  expect(ended.snapshot.currentItem?.title).toBe('b');
  expect(ended.intents).toEqual([]);
  await page.evaluate(() => window.roomProbe.next());
  const explicit = await page.evaluate(() => window.roomProbe.state());
  expect(explicit.intents).toHaveLength(1);
  expect(explicit.intents[0]).toMatchObject({ type: 'next', expectedEntryId: 'entry-b', expectedPlaybackEpoch: 50 });
  await page.evaluate(() => window.roomProbe.destroy());
});
