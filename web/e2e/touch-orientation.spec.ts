import type { Locator, Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';
import { expectNoHorizontalOverflow } from './support/visual';

const expectMinimumTouchTarget = async (target: Locator) => {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
};

const startMobilePlayback = async (page: Page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();
  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Open Now Playing: First Light' })).toBeVisible();
};

test.describe('touch and orientation reflow', () => {
  test.use({ hasTouch: true });

  test('keeps touch targets and the active player intact from portrait to landscape', async ({ page }) => {
    test.info().annotations.push({
      type: 'manual-gate',
      description: 'Physical notch and home-indicator safe-area insets require device-level manual review.'
    });

    await startMobilePlayback(page);

    const player = page.getByRole('region', { name: 'Now playing' });
    const pause = player.getByRole('button', { name: 'Pause' });
    const mobileSearch = page.locator('nav[aria-label="Primary"]')
      .last()
      .getByRole('link', { name: 'Search' });
    await expectMinimumTouchTarget(pause);
    await expectMinimumTouchTarget(mobileSearch);
    await pause.tap();
    await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    const compactOpen = page.getByRole('button', { name: 'Open Now Playing: First Light' });
    await compactOpen.tap();
    const expanded = page.getByRole('dialog', { name: 'First Light' });
    await expect(expanded).toBeVisible();

    await page.setViewportSize({ width: 740, height: 390 });
    expect(await page.evaluate(() => matchMedia('(orientation: landscape)').matches)).toBe(true);
    await expect(expanded).toBeVisible();
    await expect(expanded.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => matchMedia('(orientation: portrait)').matches)).toBe(true);
    await expect(expanded).toBeVisible();
    await expanded.getByRole('button', { name: 'Close expanded player' }).tap();
    await expect(expanded).toBeHidden();

    await player.dispatchEvent('pointerdown', {
      button: 0,
      clientX: 300,
      clientY: 790,
      isPrimary: true,
      pointerId: 7,
      pointerType: 'touch'
    });
    await player.dispatchEvent('pointerup', {
      button: 0,
      clientX: 180,
      clientY: 790,
      isPrimary: true,
      pointerId: 7,
      pointerType: 'touch'
    });
    await expect(page.getByRole('button', { name: 'Open Now Playing: Night Window' })).toBeVisible();
  });
});
