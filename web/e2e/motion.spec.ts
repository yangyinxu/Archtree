import type { Page } from '@playwright/test';

import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

interface LayoutShiftProbe {
  supported: boolean;
  total: number;
  observer?: PerformanceObserver;
}

const installLayoutShiftProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const supported = Boolean(PerformanceObserver.supportedEntryTypes?.includes('layout-shift'));
    const probe: LayoutShiftProbe = { supported, total: 0 };
    Object.defineProperty(window, '__finitudeE2ELayoutShift', {
      configurable: false,
      value: probe
    });
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        probe.total += (entry as PerformanceEntry & { value?: number }).value ?? 0;
      }
    });
    observer.observe({ buffered: true, type: 'layout-shift' });
    probe.observer = observer;
  });
};

const readLayoutShift = (page: Page) => page.evaluate(() => {
  const probe = (window as Window & { __finitudeE2ELayoutShift?: LayoutShiftProbe })
    .__finitudeE2ELayoutShift;
  if (!probe) return { supported: false, total: 0 };
  for (const entry of probe.observer?.takeRecords() ?? []) {
    probe.total += (entry as PerformanceEntry & { value?: number }).value ?? 0;
  }
  return { supported: probe.supported, total: probe.total };
});

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

test('samples the expanded player at motion start, midpoint, and end without layout shift', async ({ browserName, page }) => {
  await installLayoutShiftProbe(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await startMobilePlayback(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--motion-medium', '1000ms'));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const initialShift = await readLayoutShift(page);
  if (browserName === 'chromium') expect(initialShift.supported).toBe(true);
  test.skip(
    !initialShift.supported,
    `${browserName} does not expose PerformanceObserver layout-shift entries; CLS remains a Chromium gate.`
  );
  const beforeShift = initialShift.total;

  await page.getByRole('button', { name: 'Open Now Playing: First Light' }).click();
  const expanded = page.getByRole('dialog', { name: 'First Light' });
  await expanded.waitFor({ state: 'attached' });

  const frames = await expanded.evaluate(async (element) => {
    const animation = element.getAnimations().find((candidate) => candidate.playState !== 'finished');
    if (!animation) return null;
    animation.pause();
    const sample = async (currentTime: number) => {
      animation.currentTime = currentTime;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(element);
      return {
        opacity: Number.parseFloat(style.opacity),
        top: element.getBoundingClientRect().top,
        transform: style.transform
      };
    };
    const result = {
      start: await sample(0),
      middle: await sample(500),
      end: await sample(999)
    };
    animation.finish();
    return result;
  });

  expect(frames).not.toBeNull();
  expect(frames!.start.opacity).toBeLessThan(0.1);
  expect(frames!.middle.opacity).toBeGreaterThan(frames!.start.opacity);
  expect(frames!.end.opacity).toBeGreaterThan(frames!.middle.opacity);
  expect(frames!.end.opacity).toBeGreaterThan(0.99);
  expect(frames!.start.top - frames!.end.top).toBeGreaterThanOrEqual(10);
  expect(frames!.start.transform).not.toBe(frames!.end.transform);

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const afterShift = await readLayoutShift(page);
  expect(afterShift.supported).toBe(true);
  expect(afterShift.total - beforeShift).toBeLessThanOrEqual(0.001);
});

test.describe('reduced motion', () => {
  test('removes presentation motion while preserving Escape and focus return', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startMobilePlayback(page);

    const compactOpen = page.getByRole('button', { name: 'Open Now Playing: First Light' });
    await compactOpen.click();
    const expanded = page.getByRole('dialog', { name: 'First Light' });
    await expect(expanded).toBeVisible();
    expect(await expanded.evaluate((element) => {
      const style = getComputedStyle(element);
      const durations = style.animationDuration.split(',').map((value) => {
        const numeric = Number.parseFloat(value);
        return value.trim().endsWith('ms') ? numeric : numeric * 1_000;
      });
      return Math.max(...durations);
    })).toBeLessThanOrEqual(1);

    const helpTrigger = expanded.getByRole('button', { name: 'Keyboard shortcuts' });
    await helpTrigger.click();
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    expect(await help.evaluate((element) => {
      const style = getComputedStyle(element);
      const durations = style.animationDuration.split(',').map((value) => {
        const numeric = Number.parseFloat(value);
        return value.trim().endsWith('ms') ? numeric : numeric * 1_000;
      });
      return Math.max(...durations);
    })).toBeLessThanOrEqual(1);

    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(helpTrigger).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(expanded).toBeHidden();
    await expect(compactOpen).toBeFocused();
  });
});
