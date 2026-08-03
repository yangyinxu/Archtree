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

const pages = [
  {
    label: 'home',
    path: '/listen',
    ready: (page: Page) => page.getByRole('heading', { name: 'Leave room for the music.' })
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
