import type { Locator, Page } from '@playwright/test';

import { privatePlaylistSummary, privateViewerSession } from './fixtures/privateListener';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';
import { expectSignedInVisualShellReady } from './support/visual';

/** Checks the actual pointer target before clicking, without locator auto-scrolling. */
const clickReachableControl = async (page: Page, control: Locator) => {
  const bounds = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const sidebar = element.closest('aside')!.getBoundingClientRect();
    const points = [
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + 8, box.top + 8],
      [box.right - 8, box.top + 8],
      [box.left + 8, box.bottom - 8],
      [box.right - 8, box.bottom - 8]
    ];
    return {
      inside: box.top >= sidebar.top && box.bottom <= sidebar.bottom
        && box.left >= sidebar.left && box.right <= sidebar.right,
      unobscured: points.every(([x, y]) => element.contains(document.elementFromPoint(x!, y!))),
      x: box.left + box.width / 2,
      y: box.top + box.height / 2
    };
  });
  expect(bounds.inside).toBe(true);
  expect(bounds.unobscured).toBe(true);
  await page.mouse.click(bounds.x, bounds.y);
};

for (const width of [844, 1280]) {
  test(`short ${width}×390 sidebar keeps language, Playlist and Together reachable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 390 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installPrivateListenerRoutes(page);
    await page.route('**/api/social/v1/relationships?*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Finitude-Account-Viewer': privateViewerSession.user.id },
      body: JSON.stringify({ items: [], nextCursor: null })
    }));
    await page.goto('/finitude');
    await expectSignedInVisualShellReady(
      page, privateViewerSession.user.displayName, privatePlaylistSummary.name
    );
    await expect(page.getByRole('heading', { name: 'Featured albums' })).toBeVisible();
    const sidebar = page.getByRole('complementary', { name: 'Finitude Library' });
    const language = sidebar.getByRole('button', { name: /^Change language\./ });
    await expect(language).toBeAttached();
    const bounds = (await sidebar.boundingBox())!;

    // Wheel over the sidebar padding so a nested Playlist list cannot consume it.
    await page.mouse.move(bounds.x + 3, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop > 0
      && element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
    await clickReachableControl(page, language);
    await expect(page.getByRole('dialog', { name: 'Choose your language' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const screenshotPath = testInfo.outputPath(`sidebar-${width}-scrolled.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`sidebar-${width}-scrolled`, {
      path: screenshotPath, contentType: 'image/png'
    });

    await clickReachableControl(page, sidebar.getByRole('button', { name: 'New Playlist' }));
    await expect(page.getByRole('dialog', { name: 'Create a Playlist' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.mouse.move(bounds.x + 3, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -1000);
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBe(0);
    await clickReachableControl(page, sidebar.getByRole('link', { name: 'Together' }));
    await expect(page).toHaveURL(/\/finitude\/social$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Listen together' })).toBeVisible();
  });
}
