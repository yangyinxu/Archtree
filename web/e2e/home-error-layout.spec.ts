import { expect, test } from './support/test';

test('centers the Home retry action when the catalog is unavailable', async ({ page }) => {
  await page.route('**/api/listener/v1/home', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ message: 'Catalog unavailable.' })
  }));
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto('/finitude');

  const heading = page.getByRole('heading', { name: 'Home is taking a quiet moment' });
  const panel = heading.locator('..').locator('..');
  const retryButton = page.getByRole('button', { name: 'Try again' });
  await expect(retryButton).toBeVisible();

  const [panelBox, buttonBox] = await Promise.all([
    panel.boundingBox(),
    retryButton.boundingBox()
  ]);
  expect(panelBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  const panelCenter = panelBox!.x + (panelBox!.width / 2);
  const buttonCenter = buttonBox!.x + (buttonBox!.width / 2);
  expect(Math.abs(buttonCenter - panelCenter)).toBeLessThanOrEqual(1);
});
