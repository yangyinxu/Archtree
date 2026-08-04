import { expect, test } from './support/test';

test('previews debounced searches but records only explicit submissions', async ({ api, page }) => {
  await page.goto('/listen/search');

  const search = page.getByRole('main').getByRole('search', { name: 'Search results' });
  const input = search.getByRole('searchbox', {
    name: 'Search artists, albums, and soundtracks'
  });
  await expect(input).toHaveAttribute('enterkeyhint', 'search');
  await expect(search.getByRole('button', { name: 'Search' })).toHaveCount(0);
  await input.fill('Night');
  await page.waitForTimeout(350);

  const searchCalls = () => api.calls.filter(
    (call) => call.method === 'GET' && call.pathname === '/api/listener/v1/search'
  );
  await expect(page).toHaveURL(/\/listen\/search\?q=Night$/);
  await expect(page.getByRole('heading', { name: 'Results for “Night”' })).toBeVisible();
  expect(searchCalls()).toEqual([
    expect.objectContaining({ search: '?q=Night' })
  ]);
  expect(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  ))).toBeNull();

  await input.press('Backspace');
  await page.waitForTimeout(350);

  await expect(page).toHaveURL(/\/listen\/search\?q=Nigh$/);
  await expect(page.getByRole('heading', { name: 'Results for “Nigh”' })).toBeVisible();
  expect(searchCalls()).toEqual([
    expect.objectContaining({ search: '?q=Night' }),
    expect.objectContaining({ search: '?q=Nigh' })
  ]);

  await input.press('Enter');

  await expect(page).toHaveURL(/\/listen\/search\?q=Nigh$/);
  await expect(page.getByRole('heading', { name: 'Results for “Nigh”' })).toBeVisible();
  expect(searchCalls()).toHaveLength(2);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  )) ?? 'null')).toEqual(['Nigh']);

  await input.fill('Dawn');
  await page.waitForTimeout(350);
  await expect(page).toHaveURL(/\/listen\/search\?q=Dawn$/);
  expect(searchCalls()).toHaveLength(3);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  )) ?? 'null')).toEqual(['Nigh']);

  await input.press('Enter');
  await expect(page).toHaveURL(/\/listen\/search\?q=Dawn$/);
  await expect(page.getByRole('heading', { name: 'Results for “Dawn”' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  )) ?? 'null')).toEqual(['Dawn', 'Nigh']);

  await page.goBack();

  await expect(page).toHaveURL(/\/listen\/search\?q=Nigh$/);
  await expect(page.getByRole('heading', { name: 'Results for “Nigh”' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  )) ?? 'null')).toEqual(['Dawn', 'Nigh']);

  await page.goForward();

  await expect(page).toHaveURL(/\/listen\/search\?q=Dawn$/);
  await expect(page.getByRole('heading', { name: 'Results for “Dawn”' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem(
    'finitude:search-history:anonymous'
  )) ?? 'null')).toEqual(['Dawn', 'Nigh']);
});
