import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

let preview: { server: Server; url: string };

test.beforeAll(async () => {
  // The same generated documents are reviewed without a database or application credentials.
  // HTTP middleware authorization is exercised separately by engineeringRoutes.test.ts.
  const previewModule = fileURLToPath(new URL('../../scripts/preview-engineering.mjs', import.meta.url));
  const { startEngineeringPreview } = await import(previewModule);
  preview = await startEngineeringPreview({ port: 0 });
});

test.afterAll(async () => {
  if (preview) await new Promise<void>((resolve, reject) => preview.server.close(error => error ? reject(error) : resolve()));
});

test('hosted engineering deep links retain the destination through Archtree login', async ({ page }) => {
  await page.goto('/engineering/flows/read-album');
  await expect(page).toHaveURL(/\/auth\/login-web\?returnTo=%2Fengineering%2Fflows%2Fread-album$/);
  await expect(page.getByRole('heading', { name: 'Log in to Archtree' })).toBeVisible();
  await expect(page.locator('input[name="returnTo"]')).toHaveValue('/engineering/flows/read-album');
});

test('guide navigation supports deep links, refresh, back, anchors and keyboard focus', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(preview.url);
  const homeTitle = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByRole('link', { name: 'Set up your workspace' }).click();
  await expect(page).toHaveURL(`${preview.url}/start`);
  await page.reload();
  await expect(page.locator('nav[aria-label="Engineering guide"] a[aria-current="page"]')).toHaveAttribute('href', '/engineering/start');
  const firstOutlineLink = page.locator('.page-outline nav a').first();
  const hash = await firstOutlineLink.getAttribute('href');
  await firstOutlineLink.click();
  await expect(page).toHaveURL(new RegExp(`${hash}$`));
  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.goto(`${preview.url}/flows/read-album`);
  await expect(page.locator('.walkthrough li')).not.toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(`${preview.url}/flows/read-album`);
  await page.getByRole('link', { name: 'Archtree Engineering overview' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(homeTitle || '');
  await page.goBack();
  await expect(page).toHaveURL(`${preview.url}/flows/read-album`);
  expect(failures).toEqual([]);
});

for (const width of [320, 768, 1440]) {
  test(`guide remains readable and accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const slug of ['', '/start', '/architecture', '/flows/read-album']) {
      const response = await page.goto(`${preview.url}${slug}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth
      }));
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
    }
    if (width <= 900) {
      const navigation = page.getByRole('navigation', { name: 'Engineering guide' });
      await expect(navigation).toBeHidden();
      await page.locator('.sidebar-menu summary').click();
      await expect(navigation).toBeVisible();
      await navigation.getByRole('link', { name: 'Get started' }).click();
      await expect(page).toHaveURL(`${preview.url}/start`);
    }
  });
}

test('guide remains navigable without JavaScript and rejects unpublished files', async ({ browser, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(preview.url);
    await expect(page.getByRole('navigation', { name: 'Engineering guide' })).toBeVisible();
    await page.getByRole('link', { name: 'Set up your workspace' }).click();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('pre').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy commands' })).toBeHidden();
    expect((await request.get(`${preview.url}/manifest.json`)).status()).toBe(404);
    expect((await request.get(`${preview.url}/not-a-page`)).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test('hosted Chinese engineering deep links retain their locale through Archtree login', async ({ page }) => {
  await page.goto('/engineering/zh-hans/flows/read-album');
  await expect(page).toHaveURL(/\/auth\/login-web\?returnTo=%2Fengineering%2Fzh-hans%2Fflows%2Fread-album$/);
  await expect(page.getByRole('heading', { name: 'Log in to Archtree' })).toBeVisible();
  await expect(page.locator('input[name="returnTo"]')).toHaveValue('/engineering/zh-hans/flows/read-album');
});

test('switching guide language preserves the topic and section through refresh and browser history', async ({ page }) => {
  const englishTopic = `${preview.url}/flows/read-album#server`;
  const chineseTopic = `${preview.url}/zh-hans/flows/read-album#server`;
  await page.goto(englishTopic);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await page.locator('.language-selector').getByRole('link', { name: '简体中文', exact: true }).click();
  await expect(page).toHaveURL(chineseTopic);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('追踪专辑从 URL 到界面的全过程');
  await expect(page.locator('.language-selector a[aria-current="true"]')).toHaveText('简体中文');
  await page.reload();
  await expect(page).toHaveURL(chineseTopic);
  await expect(page.getByRole('navigation', { name: '工程指南', exact: true })).toBeVisible();
  await page.locator('.language-selector').getByRole('link', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(englishTopic);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trace an Album from URL to screen');
  await page.goBack();
  await expect(page).toHaveURL(chineseTopic);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
});

test('Chinese cards and navigation keep the selected language', async ({ page }) => {
  await page.goto(`${preview.url}/zh-hans/flows`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('沿请求追踪实现');
  const cards = page.locator('a.guide-card');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const href of await cards.evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    expect(href).toMatch(/^\/engineering\/zh-hans(?:\/|#|$)/);
  }
  await page.locator('a.guide-card[href="/engineering/zh-hans/flows/read-album"]').click();
  await expect(page).toHaveURL(`${preview.url}/zh-hans/flows/read-album`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('追踪专辑从 URL 到界面的全过程');
  const navigation = page.getByRole('navigation', { name: '工程指南', exact: true });
  for (const href of await navigation.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    expect(href).toMatch(/^\/engineering\/zh-hans(?:\/|$)/);
  }
  await navigation.locator('a[href="/engineering/zh-hans/modules/library"]').click();
  await expect(page).toHaveURL(`${preview.url}/zh-hans/modules/library`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('媒体库、播放记录与播放列表');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await page.goBack();
  await expect(page).toHaveURL(`${preview.url}/zh-hans/flows/read-album`);
});

for (const width of [320, 768, 1440]) {
  test(`Chinese guide remains readable and accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const slug of ['', '/architecture', '/flows/read-album', '/development']) {
      const response = await page.goto(`${preview.url}/zh-hans${slug}`);
      expect(response?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('.language-selector').getByRole('link', { name: '简体中文', exact: true })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth
      }));
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
    }
    if (width <= 900) {
      const navigation = page.getByRole('navigation', { name: '工程指南', exact: true });
      await expect(navigation).toBeHidden();
      await page.locator('.sidebar-menu summary').click();
      await expect(navigation).toBeVisible();
      await navigation.locator('a[href="/engineering/zh-hans/modules/library"]').click();
      await expect(page).toHaveURL(`${preview.url}/zh-hans/modules/library`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('媒体库、播放记录与播放列表');
    }
  });
}

test('guide language switching and Chinese navigation work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${preview.url}/flows/read-album`);
    const chinese = page.locator('.language-selector').getByRole('link', { name: '简体中文', exact: true });
    await expect(chinese).toHaveAttribute('href', '/engineering/zh-hans/flows/read-album');
    await chinese.click();
    await expect(page).toHaveURL(`${preview.url}/zh-hans/flows/read-album`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('追踪专辑从 URL 到界面的全过程');
    const navigation = page.getByRole('navigation', { name: '工程指南', exact: true });
    await expect(navigation).toBeVisible();
    await navigation.locator('a[href="/engineering/zh-hans/development"]').click();
    await expect(page).toHaveURL(`${preview.url}/zh-hans/development`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('完成并验证一次修改');
    await expect(page.locator('pre').first()).toContainText('npm run build');
    await expect(page.getByRole('button', { name: '复制命令', exact: true })).toBeHidden();
    await page.locator('.language-selector').getByRole('link', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(`${preview.url}/development`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  } finally {
    await context.close();
  }
});

test('Chinese command copying preserves command bytes and localizes success feedback', async ({ page }) => {
  // Stub only the OS clipboard boundary, keeping the generated button and guide script real.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => {
        (window as Window & { copiedEngineeringCommands?: string }).copiedEngineeringCommands = text;
      } }
    });
  });
  await page.goto(`${preview.url}/zh-hans/development`);
  const commands = await page.locator('.code-example code').first().textContent();
  expect(commands).toContain('npm run build');
  const copy = page.locator('[data-copy-code]').first();
  await expect(copy).toHaveText('复制命令');
  await copy.click();
  await expect(copy).toHaveText('已复制');
  await expect(page.locator('#copy-status')).toContainText('已复制');
  expect(await page.evaluate(() => (window as Window & { copiedEngineeringCommands?: string }).copiedEngineeringCommands)).toBe(commands);
  await expect(copy).toHaveText('复制命令');
});

test('Chinese command copying provides localized recovery when clipboard access fails', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } }
    });
  });
  await page.goto(`${preview.url}/zh-hans/development`);
  const copy = page.locator('[data-copy-code]').first();
  await expect(copy).toHaveText('复制命令');
  await copy.click();
  await expect(page.locator('#copy-status')).toHaveText('复制失败。请选中命令后手动复制。');
  await expect(copy).toHaveText('复制命令');
  await expect(page.locator('pre').first()).toContainText('npm run build');
});
