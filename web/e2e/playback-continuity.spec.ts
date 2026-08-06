import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

interface AudioProbeWindow extends Window {
  __finitudeE2EAudioElements?: HTMLAudioElement[];
}

interface AudioProbeSnapshot {
  count: number;
  currentTime: number;
  identity: string;
  paused: boolean;
  sourcePath: string;
}

/** Counts the actual detached Audio objects created by the production store. */
const installAudioProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const nativeAudio = window.Audio;
    const audioElements: HTMLAudioElement[] = [];
    const instrumentedAudio = new Proxy(nativeAudio, {
      construct(target, argumentsList) {
        const audio = Reflect.construct(target, argumentsList) as HTMLAudioElement;
        audio.dataset.e2eAudioIdentity = `finitude-audio-${audioElements.length + 1}`;
        audioElements.push(audio);
        return audio;
      }
    });
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: instrumentedAudio,
      writable: true
    });
    Object.defineProperty(window, '__finitudeE2EAudioElements', {
      configurable: false,
      value: audioElements
    });
  });
};

const readAudioProbe = (page: Page) => page.evaluate<AudioProbeSnapshot>(() => {
  const audioElements = (window as AudioProbeWindow).__finitudeE2EAudioElements ?? [];
  const audio = audioElements[0];
  return {
    count: audioElements.length,
    currentTime: audio?.currentTime ?? -1,
    identity: audio?.dataset.e2eAudioIdentity ?? '',
    paused: audio?.paused ?? true,
    sourcePath: audio?.src ? new URL(audio.src).pathname : ''
  };
});

const expectStableAudio = async (
  page: Page,
  identity: string,
  expectedTime: number
) => {
  const snapshot = await readAudioProbe(page);
  expect(snapshot.count).toBe(1);
  expect(snapshot.identity).toBe(identity);
  expect(snapshot.paused).toBe(true);
  expect(snapshot.sourcePath).toBe(`/content/audioTrack/stream/${catalogIds.firstTrack}`);
  expect(snapshot.currentTime).toBeCloseTo(expectedTime, 2);
};

/** Verifies that an actively advancing stream never swaps or restarts its Audio object. */
const expectActiveAudio = async (
  page: Page,
  identity: string,
  minimumTime: number
) => {
  const snapshot = await readAudioProbe(page);
  expect(snapshot.count).toBe(1);
  expect(snapshot.identity).toBe(identity);
  expect(snapshot.sourcePath).toBe(`/content/audioTrack/stream/${catalogIds.firstTrack}`);
  expect(snapshot.paused).toBe(false);
  expect(snapshot.currentTime).toBeGreaterThanOrEqual(minimumTime - 0.1);
  return snapshot.currentTime;
};

const setAudioSentinel = async (page: Page, currentTime: number) => {
  await page.evaluate((time) => {
    const audio = (window as AudioProbeWindow).__finitudeE2EAudioElements?.[0];
    if (!audio) throw new Error('The shared player did not create an Audio object.');
    audio.currentTime = time;
    audio.dispatchEvent(new Event('timeupdate'));
  }, currentTime);
};

test('preserves one real Audio object, queue, and elapsed time through every shell presentation', async ({ page }) => {
  const activeSentinelTime = 1.25;
  // Match the player's 0.1-second range step so Chromium does not normalize
  // the visible slider value independently of the underlying Audio sentinel.
  const sentinelTime = 4.3;
  await installAudioProbe(page);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();

  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  const player = page.getByRole('region', { name: 'Now playing' });
  const compactControls = player.getByRole('group', { name: 'Playback controls' });
  const slider = player.getByRole('slider', { name: 'Playback position' });
  await expect(compactControls.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('max', '15');

  const initialProbe = await readAudioProbe(page);
  expect(initialProbe.count).toBe(1);
  expect(initialProbe.identity).toBe('finitude-audio-1');
  expect(initialProbe.sourcePath).toBe(`/content/audioTrack/stream/${catalogIds.firstTrack}`);
  await expect.poll(async () => (await readAudioProbe(page)).paused).toBe(false);
  await setAudioSentinel(page, activeSentinelTime);
  await expect.poll(async () => (await readAudioProbe(page)).currentTime)
    .toBeGreaterThanOrEqual(activeSentinelTime);
  let activeTime = await expectActiveAudio(page, initialProbe.identity, activeSentinelTime);
  await expect(player).toContainText('First Light');
  await expect(page.getByRole('region', { name: 'Up next' })).toContainText('Night Window');

  const aside = page.getByRole('complementary', { name: 'Now Playing details' });
  await page.getByRole('button', { name: 'Hide Now Playing view' }).click();
  await expect(aside).toBeHidden();
  activeTime = await expectActiveAudio(page, initialProbe.identity, activeTime);
  await page.getByRole('button', { name: 'Show Now Playing view' }).click();
  await expect(aside).toBeVisible();
  activeTime = await expectActiveAudio(page, initialProbe.identity, activeTime);

  await page.getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/finitude\/search$/);
  activeTime = await expectActiveAudio(page, initialProbe.identity, activeTime);
  await expect(player).toContainText('First Light');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/finitude/albums/${catalogIds.album}$`));
  activeTime = await expectActiveAudio(page, initialProbe.identity, activeTime);

  await compactControls.getByRole('button', { name: 'Pause' }).click();
  await expect(compactControls.getByRole('button', { name: 'Play' })).toBeVisible();
  await setAudioSentinel(page, sentinelTime);
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(sentinelTime, 2);
  await expectStableAudio(page, initialProbe.identity, sentinelTime);

  await page.goForward();
  await expect(page).toHaveURL(/\/finitude\/search$/);
  await expectStableAudio(page, initialProbe.identity, sentinelTime);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/finitude/albums/${catalogIds.album}$`));
  await expectStableAudio(page, initialProbe.identity, sentinelTime);

  await page.setViewportSize({ width: 799, height: 800 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeVisible();
  await expect(aside).toBeHidden();
  await expectStableAudio(page, initialProbe.identity, sentinelTime);

  await page.setViewportSize({ width: 767, height: 844 });
  const compactOpen = page.getByRole('button', { name: 'Open Now Playing: First Light' });
  await expect(compactOpen).toBeVisible();
  await compactOpen.click();
  const expanded = page.getByRole('dialog', { name: 'First Light' });
  await expect(expanded).toBeVisible();
  await expect.poll(async () => Number(await expanded
    .getByRole('slider', { name: 'Playback position' })
    .inputValue())).toBeCloseTo(sentinelTime, 2);
  await expectStableAudio(page, initialProbe.identity, sentinelTime);
  await page.keyboard.press('Escape');
  await expect(expanded).toBeHidden();
  await expect(compactOpen).toBeFocused();
  await expectStableAudio(page, initialProbe.identity, sentinelTime);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeVisible();
  await expect(aside).toBeVisible();
  await expectStableAudio(page, initialProbe.identity, sentinelTime);

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expect(page.getByRole('region', { name: 'Up next' })).toContainText('Night Window');
  await expect(compactControls.getByRole('button', { name: 'Next soundtrack' })).toBeEnabled();
  await expectStableAudio(page, initialProbe.identity, sentinelTime);
});
