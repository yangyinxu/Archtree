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

test('shows the active Album track with animated bars and a highlighted Pause action', async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/finitude/albums/${catalogIds.album}`);

  const trackRow = page.getByRole('main')
    .locator('li')
    .filter({ hasText: 'Night Window' })
    .first();
  const playAction = trackRow.getByRole('button', { name: 'Play Night Window' });
  const title = trackRow.getByText('Night Window', { exact: true });
  await playAction.click();

  const pauseAction = trackRow.getByRole('button', { name: 'Pause' });
  const bars = pauseAction.locator('svg.lucide-audio-lines');
  const pauseIcon = pauseAction.locator('svg.lucide-pause');
  await pauseAction.evaluate((element) => (element as HTMLElement).blur());
  await page.mouse.move(0, 0);
  await expect(trackRow).toHaveAttribute('data-playback-state', 'playing');
  await expect(pauseAction).toHaveAttribute('aria-current', 'true');
  await expect(title).toHaveCSS('color', 'rgb(30, 215, 96)');
  await expect(bars).toHaveCSS('opacity', '1');
  await expect(pauseIcon).toHaveCSS('opacity', '0');
  await expect.poll(
    () => bars.locator('path').first().evaluate((element) => getComputedStyle(element).animationName)
  ).not.toBe('none');

  await pauseAction.hover();
  await expect(bars).toHaveCSS('opacity', '0');
  await expect(pauseIcon).toHaveCSS('opacity', '1');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(
    () => bars.locator('path').first().evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('none');

  await page.mouse.move(0, 0);
  await pauseAction.focus();
  await expect(bars).toHaveCSS('opacity', '0');
  await expect(pauseIcon).toHaveCSS('opacity', '1');

  await pauseAction.click();
  await expect(trackRow).not.toHaveAttribute('data-playback-state', 'playing');
  await expect(trackRow.getByRole('button', { name: 'Play Night Window' })).toBeVisible();
});
