import { trackFixtures } from './fixtures/catalog';
import { privatePlaylistSummary, privateViewerId } from './fixtures/privateListener';
import { installPrivateListenerRoutes } from './support/privateRoutes';
import { expect, test } from './support/test';

test('Library separates empty playlists, saved music and unsaved history', async ({ page }) => {
  await installPrivateListenerRoutes(page, { playlists: [{ ...privatePlaylistSummary, itemCount: 0 }] });
  await page.route('**/api/listener/v1/recently-played', (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'X-Finitude-Account-Viewer': privateViewerId },
    body: JSON.stringify({ items: [{ content: trackFixtures[1], saved: false, playedAt: '2026-09-07T10:00:00.000Z' }], limit: 20 })
  }));
  await page.goto('/finitude/library');
  const main = page.getByRole('main');
  await expect(main.getByRole('region', { name: 'My Playlists' }).getByText('Playlist · 0 MediaTracks')).toBeVisible();
  await expect(main.getByRole('region', { name: 'Saved music' })).toBeVisible();
  const recent = main.getByRole('region', { name: 'Recently played' });
  await expect(recent.getByText(trackFixtures[1].title)).toBeVisible();
  await expect(recent.getByRole('button', { name: 'Save to Library', exact: true })).toBeVisible();
  await main.getByRole('navigation').getByRole('link', { name: 'Saved music' }).click();
  await main.getByRole('button', { name: 'Albums', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Albums', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await main.getByRole('button', { name: 'Songs', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Albums', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await main.getByRole('searchbox').fill('no-matching-title');
  await expect(main.getByText('Nothing matches these filters')).toBeVisible();
  await main.getByRole('searchbox').clear();
  await expect(main.getByRole('button', { name: 'Remove from Library', exact: true })).toBeVisible();
});

test('Library navigation and section search fit a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude/library?section=saved');
  const main = page.getByRole('main');
  await expect(main.getByRole('searchbox')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Songs', exact: true })).toBeVisible();
  const tabs = await main.getByRole('navigation').getByRole('link').evaluateAll((links) => links.map((link) => {
    const box = link.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(tabs).toHaveLength(4);
  expect(tabs[0].y).toBe(tabs[1].y);
  expect(tabs[2].y).toBe(tabs[3].y);
  expect(tabs[2].y).toBeGreaterThan(tabs[0].y);
  const search = page.getByRole('search', { name: 'Global search' });
  const offset = await search.evaluate((form) => {
    const circle = form.getBoundingClientRect();
    const icon = form.querySelector('button svg')!.getBoundingClientRect();
    return { x: icon.x + icon.width / 2 - circle.x - circle.width / 2,
      y: icon.y + icon.height / 2 - circle.y - circle.height / 2 };
  });
  expect(Math.abs(offset.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(offset.y)).toBeLessThanOrEqual(1);
  await search.getByRole('button', { name: 'Submit search' }).click();
  await expect(search.getByRole('searchbox')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await main.getByRole('navigation').getByRole('link', { name: 'Recently played' }).click();
  await expect(main.getByText('Play some music and find it here next time.')).toBeVisible();
});

test('all Library destinations stay visible in two columns across sidebar breakpoints', async ({ page }) => {
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude/library?section=saved');
  const navigation = page.getByRole('main').getByRole('navigation');
  await expect(navigation.getByRole('link')).toHaveCount(4);
  let rowHeight: number | undefined;
  for (const width of [1440, 1032, 960, 888, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(async () => {
      const geometry = await navigation.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        tops: [...element.querySelectorAll('a')].map((link) => link.getBoundingClientRect().top),
        visible: [...element.querySelectorAll('a')].every((link) => {
          const box = link.getBoundingClientRect();
          const parent = element.getBoundingClientRect();
          return box.left >= parent.left && box.right <= parent.right + 1
            && link.scrollWidth <= link.clientWidth;
        }),
        overflows: element.scrollWidth > element.clientWidth
      }));
      expect(new Set(geometry.tops).size).toBe(2);
      expect(geometry.tops[0]).toBe(geometry.tops[1]);
      expect(geometry.tops[2]).toBe(geometry.tops[3]);
      expect(geometry.visible).toBe(true);
      expect(geometry.overflows).toBe(false);
      rowHeight ??= geometry.height;
      expect(geometry.height).toBe(rowHeight);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }).toPass();
  }
  const links = navigation.getByRole('link');
  await links.nth(0).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(links.nth(3)).toBeFocused();
  expect(await navigation.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const last = element.querySelector('a:last-child')!.getBoundingClientRect();
    return last.left >= viewport.left && last.right <= viewport.right + 1;
  })).toBe(true);
});
