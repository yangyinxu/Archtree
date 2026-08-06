import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { privatePlaylistSummary } from './fixtures/privateListener';
import { installPrivateListenerRoutes } from './support/privateRoutes';
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

/** Waits for React-managed desktop panel widths to settle after a viewport change. */
const waitForExpandedShell = async (page: Page) => {
  await expect.poll(async () => {
    const boxes = await readShellBoxes(page);
    return [
      boxes.left.left,
      boxes.left.width,
      boxes.main.left - boxes.left.right,
      boxes.main.width,
      boxes.right.left - boxes.main.right,
      boxes.right.width,
      boxes.right.right
    ].every((actual, index) => Math.abs(actual - [8, 280, 8, 416, 8, 280, 1_000][index]!) <= 1);
  }).toBe(true);
};

/** Drags a vertical separator by a physical horizontal distance. */
const dragSeparator = async (page: Page, label: string, deltaX: number) => {
  const handle = page.getByRole('separator', { name: label });
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + bounds!.width / 2;
  const startY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 8 });
  await page.mouse.up();
};

test('prioritizes the compact left rail before dismissing Now Playing', async ({ page }) => {
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  await page.setViewportSize({ width: 1_008, height: 900 });
  await expect(page.getByText('Your Library', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeVisible();
  await waitForExpandedShell(page);
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
  const compactPlaylist = page.getByRole('complementary', { name: 'Finitude Library' })
    .getByRole('link', {
      name: `${privatePlaylistSummary.name}, ${privatePlaylistSummary.itemCount} soundtracks`
    });
  await expect(compactPlaylist).toBeVisible();
  const compact = await readShellBoxes(page);
  expectNear(compact.left.width, 72);
  expectNear(compact.main.width, 623);
  expectNear(compact.right.width, 280);

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(compactPlaylist).toBeVisible();
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
  await expect(compactPlaylist).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeHidden();
  await expect(page.locator('nav[aria-label="Primary"]').last()).toBeHidden();
  expectNear(await compactOnlyLeft.evaluate((element) => element.getBoundingClientRect().width), 72);
  expectNear(await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width), 672);

  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.getByRole('complementary', { name: 'Finitude Library' })).toBeHidden();
  await expect(compactPlaylist).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Now Playing details' })).toBeHidden();
  await expect(page.locator('nav[aria-label="Primary"]').last()).toBeVisible();
  expectNear(await page.getByRole('main').evaluate((element) => element.getBoundingClientRect().width), 767);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(767);
});

test('resizes both wide panels, preserves the main pane, and restores preferences', async ({ page }) => {
  await page.setViewportSize({ width: 1_728, height: 900 });
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  const player = page.getByRole('region', { name: 'Now playing' });
  await player.evaluate((element) => {
    element.setAttribute('data-e2e-player-identity', 'resizing-stable');
  });
  const sidebarHandle = page.getByRole('separator', { name: 'Resize Library panel' });
  const nowPlayingHandle = page.getByRole('separator', {
    name: 'Resize Now Playing panel'
  });
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '303');
  await expect(sidebarHandle).toHaveAttribute('aria-valuemax', '420');
  await expect(nowPlayingHandle).toHaveAttribute('aria-valuenow', '303');

  await dragSeparator(page, 'Resize Library panel', 160);
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '420');
  await dragSeparator(page, 'Resize Now Playing panel', -160);
  await expect(nowPlayingHandle).toHaveAttribute('aria-valuenow', '420');

  const expanded = await readShellBoxes(page);
  expectNear(expanded.left.width, 420);
  expectNear(expanded.right.width, 420);
  expect(expanded.main.width).toBeGreaterThanOrEqual(416);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(1_728);
  await expect(player).toHaveAttribute('data-e2e-player-identity', 'resizing-stable');
  expect(await page.evaluate(() => JSON.parse(
    window.localStorage.getItem('finitude:shell-layout:v1') ?? 'null'
  ))).toEqual({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });

  await page.reload();
  await expect(page.getByRole('separator', { name: 'Resize Library panel' }))
    .toHaveAttribute('aria-valuenow', '420');
  await expect(page.getByRole('separator', { name: 'Resize Now Playing panel' }))
    .toHaveAttribute('aria-valuenow', '420');

  await page.setViewportSize({ width: 1_280, height: 900 });
  const constrained = await readShellBoxes(page);
  expectNear(constrained.left.width, 416);
  expectNear(constrained.main.width, 416);
  expectNear(constrained.right.width, 416);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(1_280);

  const constrainedSidebarHandle = page.getByRole('separator', {
    name: 'Resize Library panel'
  });
  expect(await page.evaluate(() => JSON.parse(
    window.localStorage.getItem('finitude:shell-layout:v1') ?? 'null'
  ))).toEqual({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });
  const constrainedHandleBounds = await constrainedSidebarHandle.boundingBox();
  expect(constrainedHandleBounds).not.toBeNull();
  await expect(constrainedSidebarHandle).toHaveAttribute('aria-valuenow', '416');
  await expect(constrainedSidebarHandle).toHaveAttribute('aria-valuemax', '416');
  await page.mouse.click(
    constrainedHandleBounds!.x + constrainedHandleBounds!.width / 2,
    constrainedHandleBounds!.y + constrainedHandleBounds!.height / 2
  );
  expect(await page.evaluate(() => JSON.parse(
    window.localStorage.getItem('finitude:shell-layout:v1') ?? 'null'
  ))).toEqual({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });

  await constrainedSidebarHandle.dispatchEvent('pointerdown', {
    button: 0,
    clientX: 100,
    isPrimary: true,
    pointerId: 73,
    pointerType: 'touch'
  });
  await constrainedSidebarHandle.dispatchEvent('pointermove', {
    clientX: 60,
    isPrimary: true,
    pointerId: 73,
    pointerType: 'touch'
  });
  await expect(constrainedSidebarHandle).toHaveAttribute('aria-valuenow', '376');
  await constrainedSidebarHandle.dispatchEvent('pointercancel', {
    isPrimary: true,
    pointerId: 73,
    pointerType: 'touch'
  });
  await expect(constrainedSidebarHandle).toHaveAttribute('aria-valuenow', '416');
  expect(await page.evaluate(() => JSON.parse(
    window.localStorage.getItem('finitude:shell-layout:v1') ?? 'null'
  ))).toEqual({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });

  await page.getByRole('button', { name: 'Hide Now Playing view' }).click();
  await expect(page.getByRole('separator', { name: 'Resize Now Playing panel' })).toBeHidden();
  await expect(page.getByRole('separator', { name: 'Resize Library panel' }))
    .toHaveAttribute('aria-valuenow', '420');
  await page.getByRole('button', { name: 'Show Now Playing view' }).click();
  await expect(page.getByRole('separator', { name: 'Resize Now Playing panel' })).toBeVisible();
});

test.describe('coarse-pointer panel resizing', () => {
  test.use({ hasTouch: true });

  test('keeps a 44 px central grab target without covering the panel edges', async ({ page }) => {
    await page.setViewportSize({ width: 1_728, height: 900 });
    await installPrivateListenerRoutes(page);
    await page.goto('/finitude');

    const handle = page.getByRole('separator', { name: 'Resize Library panel' });
    await expect(handle).toBeVisible();
    const geometry = await handle.evaluate((element) => {
      const grab = getComputedStyle(element, '::after');
      const indicator = getComputedStyle(element.querySelector('[aria-hidden="true"]')!);
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        grabHeight: Number.parseFloat(grab.height),
        grabWidth: Number.parseFloat(grab.width),
        handleWidth: element.getBoundingClientRect().width,
        indicatorOpacity: Number.parseFloat(indicator.opacity)
      };
    });

    expect(geometry.coarse).toBe(true);
    expectNear(geometry.handleWidth, 8);
    expectNear(geometry.grabWidth, 44);
    expectNear(geometry.grabHeight, 44);
    expect(geometry.indicatorOpacity).toBe(1);
  });
});

test('compacts the Album hero inside the 416 px main pane without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);

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

test('stacks authentication content inside the 416 px main pane', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/finitude/login');

  const main = await page.getByRole('main').boundingBox();
  const title = await page.getByRole('heading', {
    level: 1,
    name: 'Pick up where the music left you.'
  }).boundingBox();
  const form = await page.locator('main form').boundingBox();

  expect(main).not.toBeNull();
  expect(title).not.toBeNull();
  expect(form).not.toBeNull();
  expectNear(main!.width, 416);
  expect(form!.y).toBeGreaterThan(title!.y + title!.height);
  expect(form!.x).toBeGreaterThanOrEqual(main!.x);
  expect(form!.x + form!.width).toBeLessThanOrEqual(main!.x + main!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);
});

test('stacks Library heading controls inside the 416 px main pane', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude/library');

  const main = await page.getByRole('main').boundingBox();
  const title = await page.getByRole('heading', { level: 1, name: 'Your Library' }).boundingBox();
  const sort = await page.getByRole('combobox', { name: 'Sort' }).boundingBox();

  expect(main).not.toBeNull();
  expect(title).not.toBeNull();
  expect(sort).not.toBeNull();
  expectNear(main!.width, 416);
  expect(sort!.y).toBeGreaterThan(title!.y + title!.height);
  expect(sort!.x).toBeGreaterThanOrEqual(main!.x);
  expect(sort!.x + sort!.width).toBeLessThanOrEqual(main!.x + main!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);
});

test('lets the listener close and restore Now Playing without replacing the player', async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto('/finitude');

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
