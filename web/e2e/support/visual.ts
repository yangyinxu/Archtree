import {
  expect,
  type Page,
  type TestInfo
} from '@playwright/test';
import { fileURLToPath } from 'node:url';

const qaArtwork = new Map([
  ['/__e2e__/artwork/first-light.jpg', fileURLToPath(new URL('../fixtures/assets/first-light.jpg', import.meta.url))],
  ['/__e2e__/artwork/night-window.jpg', fileURLToPath(new URL('../fixtures/assets/night-window.jpg', import.meta.url))],
  ['/__e2e__/artwork/quiet-hours.jpg', fileURLToPath(new URL('../fixtures/assets/quiet-hours.jpg', import.meta.url))]
]);

const visualFreezePath = '/__e2e__/visual-freeze.css';
const visualFreezeCss = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`;

/**
 * Scroll-container gutter width shared by every Chromium golden.
 *
 * Headless Chromium never paints scrollbars (Playwright passes
 * --hide-scrollbars) but still reserves their gutter. On macOS that gutter
 * follows the OS "Show scroll bars" setting (0px overlay or 11px classic),
 * which moves layout breakpoints such as the Home Grid column count at
 * 1440px. 10px matches the native thin gutter of the Linux release baselines.
 */
const visualScrollbarGutterPx = 10;

/**
 * Chromium-only sheet that replaces the native gutter with a transparent custom
 * scrollbar, which is never an overlay scrollbar. Chromium ignores
 * ::-webkit-scrollbar while scrollbar-width/scrollbar-color are set, so it
 * resets the global thin default with `html *`. That selector still loses to
 * component rules such as the Carousel's `scrollbar-width: none`, so hidden
 * scrollbars stay hidden. Product CSS is not changed.
 */
const chromiumScrollbarGutterCss = `
  html * {
    scrollbar-color: auto;
    scrollbar-width: auto;
  }
  html ::-webkit-scrollbar {
    height: ${visualScrollbarGutterPx}px;
    width: ${visualScrollbarGutterPx}px;
  }
  html ::-webkit-scrollbar,
  html ::-webkit-scrollbar-corner,
  html ::-webkit-scrollbar-thumb,
  html ::-webkit-scrollbar-track {
    background: transparent !important;
    border-color: transparent !important;
  }
`;

/** Rejects a capture whose main-pane gutter would depend on the host's scrollbar setting. */
const expectPinnedScrollbarGutter = async (page: Page) => {
  // The main pane declares `scrollbar-gutter: stable`, so it reserves the gutter even without overflow.
  await expect.poll(() => page.locator('main').evaluate(
    (main: HTMLElement) => main.offsetWidth - main.clientWidth
  )).toBe(visualScrollbarGutterPx);
};

/** Serves original deterministic covers without copying them into the product bundle. */
export const installQaArtworkRoutes = async (page: Page) => {
  await page.route('**/__e2e__/artwork/**', async (route) => {
    const fixturePath = qaArtwork.get(new URL(route.request().url()).pathname);
    if (!fixturePath) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      path: fixturePath
    });
  });
};

/**
 * Freezes nondeterministic presentation details before a visual capture.
 *
 * Chromium also gets a fixed scrollbar gutter because it owns the pixel goldens;
 * Firefox and WebKit keep product scrollbars for their review attachments.
 */
export const stabilizeVisualState = async (page: Page) => {
  const pinsScrollbarGutter = page.context().browser()?.browserType().name() === 'chromium';
  await page.route(`**${visualFreezePath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: pinsScrollbarGutter ? visualFreezeCss + chromiumScrollbarGutterCss : visualFreezeCss
  }));
  await page.addStyleTag({
    url: new URL(visualFreezePath, page.url()).href
  });
  if (pinsScrollbarGutter) {
    await expectPinnedScrollbarGutter(page);
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(
    () => Array.from(document.images).every((image) => {
      const bounds = image.getBoundingClientRect();
      const isInCapture = bounds.width > 0
        && bounds.height > 0
        && bounds.bottom > 0
        && bounds.right > 0
        && bounds.top < window.innerHeight
        && bounds.left < window.innerWidth;
      return !isInCapture || (image.complete && image.naturalWidth > 0);
    }),
    undefined,
    { timeout: 7_000 }
  );
};

/** Waits for lazy signed-in shell surfaces before freezing a visual snapshot. */
export const expectSignedInVisualShellReady = async (
  page: Page,
  accountName: string,
  playlistName: string
) => {
  await expect(page.getByRole('link', { name: accountName })).toBeAttached();

  const library = page.locator('aside[aria-label="Finitude Library"]');
  await expect(library.locator('section[aria-label="Playlists"]')).toBeAttached();
  await expect(library.locator('ul[aria-label="Your Playlists"]')).toBeAttached();
  await expect(library.locator(`a[aria-label^="${playlistName},"]`)).toBeAttached();

  const nowPlaying = page.locator(
    'aside[aria-label="Now Playing details"] section[aria-label="Current MediaTrack"]'
  );
  await expect(nowPlaying).toBeAttached();
  await expect(nowPlaying).toContainText('Nothing playing');
};

/** Rejects document- or main-pane overflow while preserving vertical scroll ownership. */
export const expectNoHorizontalOverflow = async (page: Page) => {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      main: main?.scrollWidth ?? 0,
      mainViewport: main?.clientWidth ?? 0,
      viewport: document.documentElement.clientWidth
    };
  });
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.main).toBeLessThanOrEqual(dimensions.mainViewport + 1);
};

/** Uses named Chromium goldens while retaining review attachments elsewhere. */
export const verifyVisualEvidence = async (
  page: Page,
  testInfo: TestInfo,
  label: string
) => {
  if (testInfo.project.name === 'chromium') {
    await expect(page).toHaveScreenshot(`${label}.png`, {
      animations: 'disabled',
      fullPage: false
    });
    return;
  }

  await testInfo.attach(`${label}-${testInfo.project.name}`, {
    body: await page.screenshot({ animations: 'disabled', fullPage: false }),
    contentType: 'image/png'
  });
};
