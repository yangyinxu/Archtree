import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

const releaseBlockingImpacts = new Set(['critical', 'serious']);

/** Fails only release-blocking axe findings while retaining the complete report. */
const expectNoReleaseBlockingViolations = async (page: Page, label: string) => {
  const results = await new AxeBuilder({ page }).analyze();
  await test.info().attach(`axe-${label}`, {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json'
  });
  const violations = results.violations.filter((violation) =>
    violation.impact && releaseBlockingImpacts.has(violation.impact)
  );

  expect(
    violations,
    `${label} has critical or serious axe findings:\n${JSON.stringify(violations, null, 2)}`
  ).toEqual([]);
};

test.beforeEach(async ({ page }) => {
  // Accessibility scans should evaluate settled colors, not a transient frame
  // of an entrance animation or hover transition.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const pages = [
  {
    label: 'home',
    path: '/listen',
    ready: (page: Page) => page.getByRole('heading', { name: 'Browser Test Listening Room' })
  },
  {
    label: 'album',
    path: `/listen/albums/${catalogIds.album}`,
    ready: (page: Page) => page.getByRole('heading', { level: 1, name: 'Quiet Hours' })
  },
  {
    label: 'login',
    path: '/listen/login',
    ready: (page: Page) => page.getByRole('heading', { name: 'Pick up where the music left you.' })
  }
] as const;

for (const target of pages) {
  test(`${target.label} has no critical or serious axe findings`, async ({ page }) => {
    await page.goto(target.path);
    await expect(target.ready(page)).toBeVisible();
    await expectNoReleaseBlockingViolations(page, target.label);
  });
}

test('mobile expanded player and shortcut help have no release-blocking axe findings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/listen/albums/${catalogIds.album}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quiet Hours' })).toBeVisible();

  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  await page.getByRole('button', { name: 'Open Now Playing: First Light' }).click();

  const expanded = page.getByRole('dialog', { name: 'First Light' });
  await expect(expanded).toBeVisible();
  await expectNoReleaseBlockingViolations(page, 'mobile-expanded-player');

  await expanded.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectNoReleaseBlockingViolations(page, 'mobile-expanded-player-help');
});
