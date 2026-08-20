import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

interface MediaProbeWindow extends Window {
  __finitudeE2EMediaElements?: HTMLVideoElement[];
}

interface MediaProbeSnapshot {
  ariaHidden: string | null;
  count: number;
  controls: boolean;
  currentTime: number;
  identity: string;
  isConnected: boolean;
  paused: boolean;
  sourcePath: string;
  tabIndex: number;
}

/** Counts the one shared video element used for both audio and video sources. */
const installMediaProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const nativeCreateElement = Document.prototype.createElement;
    const mediaElements: HTMLVideoElement[] = [];
    Document.prototype.createElement = function createElement(
      this: Document,
      tagName: string,
      options?: ElementCreationOptions
    ) {
      const element = nativeCreateElement.call(this, tagName, options);
      if (tagName.toLowerCase() === 'video') {
        const media = element as HTMLVideoElement;
        media.dataset.e2eMediaIdentity = `finitude-media-${mediaElements.length + 1}`;
        Object.defineProperty(media, 'requestFullscreen', {
          configurable: true,
          value: async () => undefined
        });
        mediaElements.push(media);
      }
      return element;
    } as typeof Document.prototype.createElement;
    Object.defineProperty(window, '__finitudeE2EMediaElements', {
      configurable: false,
      value: mediaElements
    });
  });
};

const readMediaProbe = (page: Page) => page.evaluate<MediaProbeSnapshot>(() => {
  const mediaElements = (window as MediaProbeWindow).__finitudeE2EMediaElements ?? [];
  const media = mediaElements[0];
  return {
    ariaHidden: media?.getAttribute('aria-hidden') ?? null,
    count: mediaElements.length,
    controls: media?.controls ?? false,
    currentTime: media?.currentTime ?? -1,
    identity: media?.dataset.e2eMediaIdentity ?? '',
    isConnected: media?.isConnected ?? false,
    paused: media?.paused ?? true,
    sourcePath: media?.src ? new URL(media.src).pathname : '',
    tabIndex: media?.tabIndex ?? -1
  };
});

const expectStableMedia = async (
  page: Page,
  identity: string,
  expectedTime: number,
  sourcePath: string
) => {
  const snapshot = await readMediaProbe(page);
  expect(snapshot.count).toBe(1);
  expect(snapshot.identity).toBe(identity);
  expect(snapshot.isConnected).toBe(true);
  expect(snapshot.paused).toBe(true);
  expect(snapshot.sourcePath).toBe(sourcePath);
  expect(snapshot.currentTime).toBeCloseTo(expectedTime, 2);
};

/** Verifies that an active stream never swaps or restarts its shared media element. */
const expectActiveMedia = async (
  page: Page,
  identity: string,
  minimumTime: number,
  sourcePath: string
) => {
  const snapshot = await readMediaProbe(page);
  expect(snapshot.count).toBe(1);
  expect(snapshot.identity).toBe(identity);
  expect(snapshot.isConnected).toBe(true);
  expect(snapshot.sourcePath).toBe(sourcePath);
  expect(snapshot.paused).toBe(false);
  expect(snapshot.currentTime).toBeGreaterThanOrEqual(minimumTime - 0.1);
  return snapshot.currentTime;
};

const setMediaSentinel = async (page: Page, currentTime: number) => {
  await page.evaluate((time) => {
    const media = (window as MediaProbeWindow).__finitudeE2EMediaElements?.[0];
    if (!media) throw new Error('The shared player did not create its media element.');
    media.currentTime = time;
    media.dispatchEvent(new Event('timeupdate'));
  }, currentTime);
};

test('preserves one media element, queue, and elapsed time through every shell presentation', async ({ page }) => {
  const activeSentinelTime = 1.25;
  const sentinelTime = 4.3;
  const videoPath = `/content/mediaTrack/stream/${catalogIds.firstTrack}`;
  const audioPath = `/content/mediaTrack/stream/${catalogIds.secondTrack}`;
  await installMediaProbe(page);
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
  await expect.poll(async () => Number(await slider.getAttribute('max'))).toBeCloseTo(15, 0);

  const initialProbe = await readMediaProbe(page);
  expect(initialProbe.count).toBe(1);
  expect(initialProbe.identity).toBe('finitude-media-1');
  expect(initialProbe.sourcePath).toBe(videoPath);
  await expect.poll(async () => (await readMediaProbe(page)).paused).toBe(false);
  await setMediaSentinel(page, activeSentinelTime);
  await expect.poll(async () => (await readMediaProbe(page)).currentTime)
    .toBeGreaterThanOrEqual(activeSentinelTime);
  let activeTime = await expectActiveMedia(
    page,
    initialProbe.identity,
    activeSentinelTime,
    videoPath
  );
  await expect(player).toContainText('First Light');
  const theater = page.getByRole('region', { name: 'First Light' });
  await expect(theater).toBeVisible();
  await expect(theater.getByRole('img', { name: 'First Light video' })).toBeVisible();
  await expect(page.getByRole('main')).toBeHidden();
  const aside = page.getByRole('complementary', { name: 'Now Playing details' });
  await expect(aside.getByRole('region', { name: 'Video playback queue' })).toContainText('Night Window');
  await expect(page.getByRole('group', { name: 'Playback media' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Now Playing view/ })).toHaveCount(0);

  await theater.getByRole('button', { name: 'Enter video fullscreen' }).click();
  await expect.poll(async () => (await readMediaProbe(page)).controls).toBe(true);
  expect(await readMediaProbe(page)).toMatchObject({
    ariaHidden: null,
    controls: true,
    identity: initialProbe.identity,
    sourcePath: videoPath,
    tabIndex: 0
  });
  await page.evaluate(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await expect.poll(async () => (await readMediaProbe(page)).controls).toBe(false);
  expect(await readMediaProbe(page)).toMatchObject({
    ariaHidden: 'true',
    controls: false,
    identity: initialProbe.identity,
    sourcePath: videoPath,
    tabIndex: -1
  });

  await page.getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/finitude\/search$/);
  activeTime = await expectActiveMedia(page, initialProbe.identity, activeTime, videoPath);
  await expect(page.getByRole('main')).toBeHidden();
  await expect(player).toContainText('First Light');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/finitude/albums/${catalogIds.album}$`));
  activeTime = await expectActiveMedia(page, initialProbe.identity, activeTime, videoPath);

  await compactControls.getByRole('button', { name: 'Pause' }).click();
  await expect(compactControls.getByRole('button', { name: 'Play' })).toBeVisible();
  await setMediaSentinel(page, sentinelTime);
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(sentinelTime, 2);
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await compactControls.getByRole('button', { name: 'Next MediaTrack' }).click();
  await expect(player).toContainText('Night Window');
  await expect.poll(async () => (await readMediaProbe(page)).sourcePath)
    .toBe(audioPath);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(theater).toHaveCount(0);
  await expect(aside.getByRole('region', { name: 'Current MediaTrack' })).toContainText('Night Window');
  expect((await readMediaProbe(page))).toMatchObject({
    count: 1,
    identity: initialProbe.identity,
    isConnected: true,
    sourcePath: audioPath
  });

  await compactControls.getByRole('button', { name: 'Previous MediaTrack' }).click();
  await expect(player).toContainText('First Light');
  await expect.poll(async () => (await readMediaProbe(page)).sourcePath)
    .toBe(videoPath);
  await expect(page.getByRole('region', { name: 'First Light' })).toBeVisible();
  await expect(page.getByRole('main')).toBeHidden();
  await expect.poll(async () => (await readMediaProbe(page)).paused).toBe(false);
  expect((await readMediaProbe(page))).toMatchObject({
    count: 1,
    identity: initialProbe.identity,
    sourcePath: videoPath
  });

  await compactControls.getByRole('button', { name: 'Pause' }).click();
  await setMediaSentinel(page, sentinelTime);
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(sentinelTime, 2);
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await page.goForward();
  await expect(page).toHaveURL(/\/finitude\/search$/);
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/finitude/albums/${catalogIds.album}$`));
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await page.setViewportSize({ width: 799, height: 800 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeVisible();
  await expect(aside).toBeHidden();
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await page.setViewportSize({ width: 767, height: 844 });
  const compactOpen = page.getByRole('button', { name: 'Open Now Playing: First Light' });
  await expect(compactOpen).toBeVisible();
  await compactOpen.click();
  const expanded = page.getByRole('dialog', { name: 'First Light' });
  await expect(expanded).toBeVisible();
  await expect.poll(async () => Number(await expanded
    .getByRole('slider', { name: 'Playback position' })
    .inputValue())).toBeCloseTo(sentinelTime, 2);
  await expect(expanded.getByRole('img', { name: 'First Light video' })).toBeVisible();
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);
  await page.keyboard.press('Escape');
  await expect(expanded).toBeHidden();
  await expect(compactOpen).toBeFocused();
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeVisible();
  await expect(aside).toBeVisible();
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expect(aside.getByRole('region', { name: 'Video playback queue' })).toContainText('Night Window');
  await expect(compactControls.getByRole('button', { name: 'Next MediaTrack' })).toBeEnabled();
  await expectStableMedia(page, initialProbe.identity, sentinelTime, videoPath);
});
