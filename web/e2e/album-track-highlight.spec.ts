import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

test('highlights the complete Album track row through its Save column', async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);

  const playAction = page.getByRole('button', { name: 'Play First Light' });
  const trackRow = playAction.locator('..');
  const saveAction = trackRow.getByRole('button', { name: 'Save to Library' });

  const restingColor = await trackRow.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await trackRow.evaluate((element) => getComputedStyle(element)
    .getPropertyValue('--color-surface-hover').trim())).not.toBe('');

  await playAction.hover();
  await expect.poll(
    () => trackRow.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).not.toBe(restingColor);
  const highlightedColor = await trackRow.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await expect(playAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  await saveAction.hover();
  await expect.poll(
    () => trackRow.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe(highlightedColor);

  await page.mouse.move(0, 0);
  await playAction.focus();
  await expect.poll(
    () => trackRow.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe(highlightedColor);
});
