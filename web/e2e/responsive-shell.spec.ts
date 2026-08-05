import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

interface ShellBoxes {
  left: { left: number; right: number; width: number };
  main: { left: number; right: number; width: number };
  right: { left: number; right: number; width: number };
}

/** Allows only browser subpixel rounding around the measured shell contract. */
const expectNear = (actual: number, expected: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
};

/** Reads the three persistent shell regions after their breakpoint styles settle. */
const readShellBoxes = async (page: Page) => {
  const read = (name: 'Finitude Library' | 'Now Playing details') => page
    .getByRole('complementary', { name })
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
  const main = await page.getByRole('main').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });

  return {
    left: await read('Finitude Library'),
    main,
    right: await read('Now Playing details')
  } satisfies ShellBoxes;
};

test('prioritizes the compact left rail before dismissing Now Playing', async ({ page }) => {
  await page.goto('/listen');
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  await page.setViewportSize({ width: 1_008, height: 900 });
  await expect(page.getByText('Your Library', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeVisible();
  const expanded = await readShellBoxes(page);
  expectNear(expanded.left.left, 8);
  expectNear(expanded.left.width, 280);
  expectNear(expanded.main.left - expanded.left.right, 8);
  expectNear(expanded.main.width, 416);
  expectNear(expanded.right.left - expanded.main.right, 8);
  expectNear(expanded.right.width, 280);
  expectNear(expanded.right.right, 1_000);

  await page.setViewportSize({ width: 1_007, height: 900 });
  await expect(page.getByText('Your Library', { exact: true })).toBeHidden();
  const compact = await readShellBoxes(page);
  expectNear(compact.left.width, 72);
  expectNear(compact.main.width, 623);
  expectNear(compact.right.width, 280);

  await page.setViewportSize({ width: 800, height: 900 });
  const minimumThreePane = await readShellBoxes(page);
  expectNear(minimumThreePane.left.width, 72);
  expectNear(minimumThreePane.main.width, 416);
  expectNear(minimumThreePane.right.width, 280);
  expectNear(minimumThreePane.right.right, 792);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);

  await page.setViewportSize({ width: 799, height: 900 });
  const compactOnlyLeft = page.getByRole('complementary', { name: 'Finitude Library' });
  await expect(compactOnlyLeft).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Now Playing view/ })).toBeHidden();
  expectNear(await compactOnlyLeft.evaluate((element) => element.getBoundingClientRect().width), 72);
  expectNear(await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width), 703);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(compactOnlyLeft).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeHidden();
  await expect(page.locator('nav[aria-label="Primary"]').last()).toBeHidden();
  expectNear(await compactOnlyLeft.evaluate((element) => element.getBoundingClientRect().width), 72);
  expectNear(await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width), 672);

  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeHidden();
  await expect(page.locator('nav[aria-label="Primary"]').last()).toBeVisible();
  expectNear(await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width), 767);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(767);
});

test('compacts the Album hero inside the 416 px main pane without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`/listen/albums/${catalogIds.album}`);

  const main = await page.getByRole('main').boundingBox();
  const artwork = await page.getByRole('img', { name: 'Quiet Hours cover' }).boundingBox();
  const title = await page.getByRole('heading', { name: 'Quiet Hours', level: 1 }).boundingBox();

  expect(main).not.toBeNull();
  expect(artwork).not.toBeNull();
  expect(title).not.toBeNull();
  expectNear(main!.width, 416);
  expectNear(artwork!.width, 128);
  expect(artwork!.x).toBeGreaterThanOrEqual(main!.x);
  expect(title!.x + title!.width).toBeLessThanOrEqual(main!.x + main!.width);
});

test('lets the listener close and restore Now Playing without replacing the player', async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto('/listen');

  const player = page.getByRole('region', { name: 'Now playing' });
  await player.evaluate((element) => {
    element.setAttribute('data-e2e-player-identity', 'stable');
  });
  const aside = page.getByRole('complementary', { name: 'Now Playing details' });
  const main = page.getByRole('main');
  const openWidth = await main.evaluate((element) => element.getBoundingClientRect().width);

  await page.getByRole('button', { name: 'Hide Now Playing view' }).click();
  await expect(aside).toBeHidden();
  const closedWidth = await main.evaluate((element) => element.getBoundingClientRect().width);
  expect(closedWidth).toBeGreaterThan(openWidth);
  await expect(player).toHaveAttribute('data-e2e-player-identity', 'stable');

  await page.getByRole('button', { name: 'Show Now Playing view' }).click();
  await expect(aside).toBeVisible();
  await expect(player).toHaveAttribute('data-e2e-player-identity', 'stable');
});
