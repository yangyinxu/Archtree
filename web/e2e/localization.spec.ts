import { expect, test } from './support/test';

test('switches the complete listener from the bottom-left language control and persists it', async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  const sidebar = page.getByRole('complementary', { name: 'Finitude Library' });
  const trigger = sidebar.getByRole('button', {
    name: 'Change language. Current language: English (United States)'
  });
  await expect(trigger).toBeVisible();
  const [sidebarBox, triggerBox] = await Promise.all([
    sidebar.boundingBox(),
    trigger.boundingBox()
  ]);
  expect(sidebarBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  expect(triggerBox!.y).toBeGreaterThan(sidebarBox!.y + sidebarBox!.height * 0.75);
  expect(sidebarBox!.y + sidebarBox!.height - (triggerBox!.y + triggerBox!.height))
    .toBeLessThan(36);

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Choose your language' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', {
    name: 'English (United States)'
  })).toHaveAccessibleDescription('English (United States)');
  const chineseOption = dialog.getByRole('radio', { name: '简体中文' });
  await expect(chineseOption).toHaveAccessibleDescription('Simplified Chinese');
  await expect(dialog.getByText('Simplified Chinese', { exact: true })).toBeVisible();
  await chineseOption.click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('link', { name: '首页', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '音乐库' })).toBeVisible();
  await expect(page.getByRole('searchbox', {
    name: '搜索音乐人、机构、专辑和媒体曲目'
  })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem(
    'finitude.localization.preference.v1'
  ))).toBe('zh-Hans');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('link', { name: '首页', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '修改语言。当前语言：简体中文' })).toBeVisible();
});

test.describe('Web language preference', () => {
  test.use({ locale: 'zh-CN' });

  test('starts in English and offers explicit languages only', async ({ page }) => {
    await page.goto('/finitude');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem(
      'finitude.localization.preference.v1'
    ))).toBeNull();

    await page.getByRole('button', {
      name: 'Change language. Current language: English (United States)'
    }).click();
    await expect(page.getByRole('radio', { name: 'English (United States)' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Browser default' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '简体中文' })).toHaveAccessibleDescription(
      'Simplified Chinese'
    );
  });

  test('migrates a legacy Browser default preference to English', async ({ page }) => {
    await page.goto('/finitude');
    await page.evaluate(() => window.localStorage.setItem(
      'finitude.localization.preference.v1',
      'system'
    ));
    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem(
      'finitude.localization.preference.v1'
    ))).toBe('en-US');
  });
});
