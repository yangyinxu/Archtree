import type { Page } from '@playwright/test';

import {
  privatePlaylistDetail,
  privatePlaylistSummary,
  privateViewerSession
} from './fixtures/privateListener';
import {
  visualAlbumFixture,
  visualArtworkSlots,
  visualHomePlaybackTrack,
  visualHomeFixture
} from './fixtures/visualCatalog';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';
import {
  expectNoHorizontalOverflow,
  expectSignedInVisualShellReady,
  installQaArtworkRoutes,
  stabilizeVisualState,
  verifyVisualEvidence
} from './support/visual';

interface VisualViewport {
  label: string;
  width: number;
  height: number;
  shell: 'full' | 'rail-with-aside' | 'mobile';
  sideWidth?: number;
}

interface VisualAudioWindow extends Window {
  __finitudeVisualAudio?: HTMLAudioElement;
}

const visualViewports: VisualViewport[] = [
  { label: 'desktop-1280', width: 1_280, height: 800, shell: 'full', sideWidth: 303 },
  { label: 'desktop-1440', width: 1_440, height: 900, shell: 'full', sideWidth: 303 },
  { label: 'desktop-1920', width: 1_920, height: 1_080, shell: 'full', sideWidth: 303 },
  { label: 'mobile-portrait-390', width: 390, height: 844, shell: 'mobile' },
  { label: 'narrow-mobile-320', width: 320, height: 568, shell: 'mobile' },
  { label: 'mobile-landscape-844', width: 844, height: 390, shell: 'rail-with-aside', sideWidth: 72 }
];

const installVisualHome = async (page: Page) => {
  await installQaArtworkRoutes(page);
  await page.route(
    `**/api/listener/v1/albums/${visualAlbumFixture.album.id}`,
    (route) => route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(visualAlbumFixture)
    })
  );
  await page.route('**/content/me/recently-played', async (route) => {
    const target = route.request().postDataJSON() as {
      contentType: 'album' | 'audioTrack';
      contentId: string;
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Finitude-Account-Viewer': privateViewerSession.user.id
      },
      body: JSON.stringify({ ...target, recorded: true })
    });
  });
  await installPrivateListenerRoutes(page, {
    home: visualHomeFixture,
    playlistDetail: {
      ...privatePlaylistDetail,
      artworkUrl: visualArtworkSlots.blueHour
    },
    playlists: [{
      ...privatePlaylistSummary,
      artworkUrl: visualArtworkSlots.blueHour
    }]
  });
};

/** Keeps the real test stream observable and slow enough for stable active-player goldens. */
const installVisualAudioProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const nativeAudio = window.Audio;
    const instrumentedAudio = new Proxy(nativeAudio, {
      construct(target, argumentsList) {
        const audio = Reflect.construct(target, argumentsList) as HTMLAudioElement;
        (window as VisualAudioWindow).__finitudeVisualAudio = audio;
        return audio;
      }
    });
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: instrumentedAudio,
      writable: true
    });
  });
};

const pinActivePlayback = async (
  page: Page,
  expectedStreamPath: string,
  currentTime = 2
) => {
  const snapshot = await page.evaluate((time) => {
    const audio = (window as VisualAudioWindow).__finitudeVisualAudio;
    if (!audio) throw new Error('The visual candidate did not create its real Audio object.');
    audio.currentTime = time;
    audio.playbackRate = 0.0625;
    audio.dispatchEvent(new Event('timeupdate'));
    return {
      paused: audio.paused,
      sourcePath: audio.src ? new URL(audio.src).pathname : ''
    };
  }, currentTime);

  expect(snapshot).toEqual({ paused: false, sourcePath: expectedStreamPath });
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toBeEnabled();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThanOrEqual(currentTime);
};

const expectActiveVisualPlayer = async (
  page: Page,
  currentTitle: string,
  expectedStreamPath: string,
  upNextTitle?: string
) => {
  const player = page.getByRole('region', { name: 'Now playing' });
  await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(player).toContainText(currentTitle);
  const slider = player.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('max', '15');

  const aside = page.getByRole('complementary', { name: 'Now Playing details' });
  if (!await aside.isVisible()) {
    await page.getByRole('button', { name: 'Show Now Playing view' }).click();
  }
  await expect(aside).toBeVisible();
  await expect(aside.getByRole('region', { name: 'Current soundtrack' })).toContainText(currentTitle);
  if (upNextTitle) {
    await expect(aside.getByRole('region', { name: 'Up next' })).toContainText(upNextTitle);
  }

  await pinActivePlayback(page, expectedStreamPath);
};

const waitForVisualShell = (page: Page) => expectSignedInVisualShellReady(
  page,
  privateViewerSession.user.displayName,
  privatePlaylistSummary.name
);

const near = (actual: number, expected: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
};

for (const viewport of visualViewports) {
  test(`captures the deterministic ${viewport.label} shell`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installVisualHome(page);
    await page.goto('/finitude');
    await expect(page.getByRole('heading', { level: 1, name: visualHomeFixture.title })).toBeVisible();
    await waitForVisualShell(page);
    await stabilizeVisualState(page);

    await expect(page.locator('[data-presentation="carousel"]')).toHaveCount(1);
    await expect(page.locator('[data-presentation="grid"]')).toHaveCount(1);
    await expect(page.locator('[data-presentation="list"]')).toHaveCount(1);
    await expect(page.getByText('月明かりの記憶—風景を越えて響く長いタイトル').first()).toBeAttached();
    await expect(page.getByRole('button', { name: 'Play Untitled soundtrack' })).toBeAttached();
    await expectNoHorizontalOverflow(page);

    const left = page.getByRole('complementary', { name: 'Finitude Library' });
    const right = page.getByRole('complementary', { name: 'Now Playing details' });
    const desktopNavigation = page.locator('nav[aria-label="Primary"]').first();
    const mobileNavigation = page.locator('nav[aria-label="Primary"]').last();

    if (viewport.shell === 'mobile') {
      await expect(left).toBeHidden();
      await expect(right).toBeHidden();
      await expect(desktopNavigation).toBeHidden();
      await expect(mobileNavigation).toBeVisible();
      near(
        await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width),
        viewport.width
      );
    } else {
      await expect(left).toBeVisible();
      await expect(right).toBeVisible();
      await expect(desktopNavigation).toBeVisible();
      await expect(mobileNavigation).toBeHidden();
      near(
        await left.evaluate((element) => element.getBoundingClientRect().width),
        viewport.sideWidth!
      );
      if (viewport.shell === 'full') {
        near(
          await right.evaluate((element) => element.getBoundingClientRect().width),
          viewport.sideWidth!
        );
      } else {
        await expect(page.getByText('Your Library', { exact: true })).toBeHidden();
        near(await right.evaluate((element) => element.getBoundingClientRect().width), 280);
        near(
          await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width),
          460
        );
      }
    }

    const playerBox = await page.getByRole('region', { name: 'Now playing' }).boundingBox();
    expect(playerBox).not.toBeNull();
    expect(playerBox!.y).toBeGreaterThanOrEqual(0);
    expect(playerBox!.y + playerBox!.height).toBeLessThanOrEqual(viewport.height + 1);

    await verifyVisualEvidence(page, testInfo, viewport.label);
  });
}

test.describe('source-viewport Chromium goldens', () => {
  test.use({ deviceScaleFactor: 2 });

  test('captures active Home at 1728 by 889 CSS pixels', async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'Chromium owns the source-viewport golden.');
    await installVisualAudioProbe(page);
    await page.setViewportSize({ width: 1_728, height: 889 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installVisualHome(page);
    await page.goto('/finitude');
    await expect(page.getByRole('heading', { level: 1, name: visualHomeFixture.title })).toBeVisible();
    await waitForVisualShell(page);
    expect(await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth
    }))).toEqual({ devicePixelRatio: 2, height: 889, width: 1_728 });

    const current = visualHomePlaybackTrack;
    await page.getByRole('button', {
      name: `Play ${current.title} by ${current.artistNames.join(', ')}`
    }).click();
    await expectActiveVisualPlayer(page, current.title, current.streamUrl);
    await page.getByRole('main').evaluate((element) => element.scrollTo({ top: 0 }));
    await expectNoHorizontalOverflow(page);
    near(
      await page.getByRole('complementary', { name: 'Finitude Library' })
        .evaluate((element) => element.getBoundingClientRect().width),
      303
    );
    near(
      await page.getByRole('complementary', { name: 'Now Playing details' })
        .evaluate((element) => element.getBoundingClientRect().width),
      303
    );
    await stabilizeVisualState(page);
    await pinActivePlayback(page, current.streamUrl);

    await expect(page).toHaveScreenshot('reference-home-active-1728x889-dpr2.png', {
      animations: 'disabled',
      fullPage: false,
      maxDiffPixels: 500,
      scale: 'device'
    });
  });

  test('captures active Album at 857 by 888 CSS pixels', async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'Chromium owns the source-viewport golden.');
    await installVisualAudioProbe(page);
    await page.setViewportSize({ width: 857, height: 888 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installVisualHome(page);
    await page.goto(`/finitude/albums/${visualAlbumFixture.album.id}`);
    await expect(page.getByRole('heading', {
      level: 1,
      name: visualAlbumFixture.album.title
    })).toBeVisible();
    await waitForVisualShell(page);
    expect(await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth
    }))).toEqual({ devicePixelRatio: 2, height: 888, width: 857 });

    await page.getByRole('main')
      .locator('header')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    const [current, upNext] = visualAlbumFixture.tracks;
    await expectActiveVisualPlayer(page, current.title, current.streamUrl, upNext.title);
    await expectNoHorizontalOverflow(page);
    near(
      await page.getByRole('complementary', { name: 'Finitude Library' })
        .evaluate((element) => element.getBoundingClientRect().width),
      72
    );
    near(
      await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width),
      473
    );
    near(
      await page.getByRole('complementary', { name: 'Now Playing details' })
        .evaluate((element) => element.getBoundingClientRect().width),
      280
    );
    await stabilizeVisualState(page);
    await pinActivePlayback(page, current.streamUrl);

    await expect(page).toHaveScreenshot('reference-album-active-857x888-dpr2.png', {
      animations: 'disabled',
      fullPage: false,
      maxDiffPixels: 500,
      scale: 'device'
    });
  });
});

test.describe('640 CSS px reflow proxy', () => {
  test.use({
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 2
  });

  test('keeps the 640 CSS px layout reachable at a 1280 by 800 physical-pixel density', async ({ browserName, page }) => {
    test.skip(browserName !== 'chromium', 'Chromium is the designated dense-pixel reflow proxy.');
    test.info().annotations.push({
      type: 'manual-gate',
      description: 'Actual browser UI zoom at 200% remains a manual browser-matrix check.'
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installVisualHome(page);
    await page.goto('/finitude');
    await expect(page.getByRole('heading', { level: 1, name: visualHomeFixture.title })).toBeVisible();
    await waitForVisualShell(page);
    await stabilizeVisualState(page);

    expect(await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth
    }))).toEqual({ devicePixelRatio: 2, height: 400, width: 640 });
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('nav[aria-label="Primary"]').last()).toBeVisible();

    const finalTrack = page.getByRole('button', { name: 'Play 🌌 Stardust in my memory card by ミロー 🎹' });
    await finalTrack.scrollIntoViewIfNeeded();
    await expect(finalTrack).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('forced colors', () => {
  test('retains visible keyboard focus and responsive controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await installVisualHome(page);
    await page.goto('/finitude');
    await expect(page.getByRole('heading', { level: 1, name: visualHomeFixture.title })).toBeVisible();
    await waitForVisualShell(page);

    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    const focusStyle = await skipLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
    });
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(1);
    await expect(page.locator('nav[aria-label="Primary"]').last()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
