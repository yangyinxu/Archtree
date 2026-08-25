import type { Page } from '@playwright/test';

import type { ListenerHome } from '../src/api/contentSchemas';

import { albumFixture } from './fixtures/catalog';
import { expect, test } from './support/test';

const sectionTitle = 'Overflow navigation picks';
const carouselName = `${sectionTitle} carousel`;
const overflowHomeFixture = {
  title: 'Carousel navigation room',
  sections: [{
    id: 'overflow-navigation-carousel',
    title: sectionTitle,
    presentation: 'carousel',
    items: Array.from({ length: 10 }, (_, index) => ({
      ...albumFixture,
      id: `${albumFixture.id}-${index + 1}`,
      title: `${albumFixture.title} ${index + 1}`
    }))
  }]
} satisfies ListenerHome;

const installOverflowHome = async (page: Page) => {
  await page.route('**/api/listener/v1/home', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(overflowHomeFixture)
  }));
};

test('traverses real carousel overflow with controls and boundary keys', async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installOverflowHome(page);
  await page.goto('/finitude');

  const carousel = page.getByRole('list', { name: carouselName });
  await expect(carousel).toBeVisible();
  await expect.poll(() => carousel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(0);

  const firstCard = carousel.getByRole('listitem').first();
  const firstCardAction = firstCard.getByRole('link');
  const firstCardTitle = firstCard.getByText('Quiet Hours 1', { exact: true });
  const copyInsets = await Promise.all([
    firstCardAction.boundingBox(),
    firstCardTitle.boundingBox()
  ]);
  expect(copyInsets[0]).not.toBeNull();
  expect(copyInsets[1]).not.toBeNull();
  const leftInset = copyInsets[1]!.x - copyInsets[0]!.x;
  const rightInset = copyInsets[0]!.x + copyInsets[0]!.width - copyInsets[1]!.x - copyInsets[1]!.width;
  expect(leftInset).toBeGreaterThanOrEqual(4);
  expect(leftInset).toBeLessThanOrEqual(6);
  expect(rightInset).toBeGreaterThanOrEqual(4);
  expect(rightInset).toBeLessThanOrEqual(6);

  const frame = carousel.locator('..');
  const next = page.getByRole('button', { name: `Show next items in ${sectionTitle}` });
  await expect(next).toHaveAttribute('aria-controls', 'listener-section-overflow-navigation-carousel-carousel');
  await expect(page.getByRole('button', { name: `Show previous items in ${sectionTitle}` })).toHaveCount(0);

  await frame.hover();
  await expect.poll(() => next.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.99);
  const initialScroll = await carousel.evaluate((element) => element.scrollLeft);
  await next.click();
  await expect.poll(() => carousel.evaluate((element) => element.scrollLeft)).toBeGreaterThan(initialScroll);
  await expect(page.getByRole('button', { name: `Show previous items in ${sectionTitle}` })).toBeVisible();

  await carousel.focus();
  await carousel.press('End');
  await expect.poll(() => carousel.evaluate((element) =>
    Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft)
  )).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: `Show next items in ${sectionTitle}` })).toHaveCount(0);

  await carousel.press('Home');
  await expect.poll(() => carousel.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: `Show previous items in ${sectionTitle}` })).toHaveCount(0);

  await carousel.press('PageDown');
  await expect.poll(() => carousel.evaluate((element) => element.scrollLeft)).toBeGreaterThan(1);
  await carousel.press('PageUp');
  await expect.poll(() => carousel.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);
});

test('keeps carousel controls visible and immediate in reduced motion and forced colors', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await installOverflowHome(page);
  await page.goto('/finitude');

  const carousel = page.getByRole('list', { name: carouselName });
  await expect(carousel).toBeVisible();
  await carousel.focus();
  const next = page.getByRole('button', { name: `Show next items in ${sectionTitle}` });
  await expect(next).toBeVisible();

  const styles = await next.evaluate((element) => {
    const buttonStyle = getComputedStyle(element);
    const carouselStyle = getComputedStyle(document.getElementById(element.getAttribute('aria-controls')!)!);
    return {
      borderStyle: buttonStyle.borderStyle,
      borderWidth: Number.parseFloat(buttonStyle.borderWidth),
      opacity: Number.parseFloat(buttonStyle.opacity),
      scrollBehavior: carouselStyle.scrollBehavior,
      transitionDuration: buttonStyle.transitionDuration
    };
  });
  expect(styles.borderStyle).not.toBe('none');
  expect(styles.borderWidth).toBeGreaterThanOrEqual(1);
  expect(styles.opacity).toBeGreaterThan(0.99);
  expect(styles.scrollBehavior).toBe('auto');
  expect(styles.transitionDuration.split(',').every((duration) => Number.parseFloat(duration) <= 0.001)).toBe(true);

  const before = await carousel.evaluate((element) => element.scrollLeft);
  await next.click();
  expect(await carousel.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
});
