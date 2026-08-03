import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

const albumPath = `/listen/albums/${catalogIds.album}`;

test('opens the listener from the Archtree landing page without replacing account actions', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Open Finitude' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(2);

  await page.getByRole('link', { name: 'Open Finitude' }).first().click();
  await expect(page).toHaveURL(/\/listen$/);
  await expect(page.getByRole('heading', { name: 'Leave room for the music.' })).toBeVisible();
});

test('serves a production bundle deep link and survives a document reload', async ({ page }) => {
  const response = await page.goto(albumPath);

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();
});

test('keeps the Album route and persistent player while navigating', async ({ page }) => {
  await page.goto('/listen');
  await expect(page.getByRole('heading', { name: 'Leave room for the music.' })).toBeVisible();

  await page.getByRole('link', { name: 'Quiet Hours, album' }).click();
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`));

  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();

  const player = page.getByRole('region', { name: 'Now playing' });
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
  await expect(player.getByText('First Light', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/listen\/search$/);
  await expect(player.getByText('First Light', { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
  await expect(player.getByText('First Light', { exact: true })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/listen\/search$/);
  await expect(player.getByText('First Light', { exact: true })).toBeVisible();
});

test('keeps the desktop player anchored when the wheel originates over it', async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto('/listen');
  await expect(page.getByRole('heading', { level: 2, name: 'Featured albums' })).toBeVisible();

  // Force a root scroll range without making the deterministic catalog fixture
  // repetitive; the application shell must reject that accidental scroll path.
  await page.evaluate(() => {
    const overflowProbe = document.createElement('div');
    overflowProbe.setAttribute('aria-hidden', 'true');
    overflowProbe.style.height = '75rem';
    document.body.append(overflowProbe);
  });
  const player = page.getByRole('region', { name: 'Now playing' });
  await expect(player).toBeVisible();
  const readLayout = () => player.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      top: rect.top,
      viewportHeight: window.innerHeight,
      windowScrollY: window.scrollY
    };
  });
  const before = await readLayout();
  await player.getByText('Nothing playing', { exact: true }).hover();
  const wheelSettled = page.evaluate(() => new Promise<void>((resolve) => {
    window.addEventListener('wheel', () => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }, { once: true });
  }));
  await page.mouse.wheel(0, 1_200);
  await wheelSettled;

  const after = await readLayout();
  expect(after.windowScrollY).toBe(0);
  expect(Math.abs(after.bottom - after.viewportHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);

  const main = page.getByRole('main');
  await main.evaluate((element) => {
    const overflowProbe = document.createElement('div');
    overflowProbe.setAttribute('aria-hidden', 'true');
    overflowProbe.style.height = '75rem';
    element.append(overflowProbe);
  });
  const mainBox = await main.boundingBox();
  expect(mainBox).not.toBeNull();
  const mainWheelPoint = {
    x: mainBox!.x + (mainBox!.width / 2),
    y: mainBox!.y + Math.min(64, mainBox!.height / 2)
  };
  await page.mouse.move(mainWheelPoint.x, mainWheelPoint.y);
  const wheelTargetsMain = await main.evaluate((element, point) => {
    const target = document.elementFromPoint(point.x, point.y);
    return target instanceof Element && target.closest('main') === element;
  }, mainWheelPoint);
  expect(wheelTargetsMain).toBe(true);
  await page.mouse.wheel(0, 600);
  await expect.poll(
    () => main.evaluate((element) => element.scrollTop),
    { message: 'wheel over main should scroll the main container' }
  ).toBeGreaterThan(0);

  const afterMainScroll = await readLayout();
  expect(afterMainScroll.windowScrollY).toBe(0);
  expect(Math.abs(afterMainScroll.bottom - afterMainScroll.viewportHeight)).toBeLessThanOrEqual(1);
});

test('keeps signed-out Save in place without sending a mutation', async ({ api, page }) => {
  await page.goto(albumPath);
  const albumSave = page.getByRole('main')
    .getByRole('button', { name: 'Save to Library' })
    .first();

  await expect(albumSave).toHaveAttribute('aria-disabled', 'false');
  await albumSave.click();

  await expect(page.getByRole('alert')).toHaveText('Log in to save albums and soundtracks.');
  await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
  expect(api.calls.filter((call) =>
    ['PUT', 'DELETE'].includes(call.method)
      && call.pathname.startsWith('/content/me/saves/')
  )).toEqual([]);
});

test('activates the skip link and moves focus to main content', async ({ page }) => {
  await page.goto('/listen');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });

  // Safari/WebKit inherits the platform's optional link-tab preference, so begin
  // from the link itself and verify the product-owned activation/focus contract.
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('main')).toBeFocused();
});

for (const width of [320, 768, 1_440]) {
  test(`keeps the Home document within a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/listen');
    await expect(page.getByRole('heading', { name: 'Leave room for the music.' })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
  });
}

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('retains navigation and playback actions', async ({ page }) => {
    // Apply on the Page as well as the Context so every engine exposes the media query.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/listen');
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

    await page.getByRole('link', { name: 'Quiet Hours, album' }).click();
    await page.getByRole('main')
      .locator('header')
      .getByRole('button', { name: 'Play', exact: true })
      .click();

    await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
    await expect(page.getByRole('region', { name: 'Now playing' })
      .getByText('First Light', { exact: true })).toBeVisible();
  });
});
