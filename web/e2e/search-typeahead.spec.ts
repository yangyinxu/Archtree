import { catalogIds } from './fixtures/catalog';
import { expect, test } from './support/test';

const fieldName = 'Search artists, organizations, albums, and MediaTracks';
const storedHistory = (page: import('@playwright/test').Page) => page.evaluate(() => JSON.parse(
  localStorage.getItem('finitude:search-history:anonymous') ?? 'null'
));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
});

test('wide-layout typeahead previews results on the current route and opens a highlighted Album', async ({ api, page }) => {
  await page.goto('/finitude');
  const field = page.getByRole('combobox', { name: fieldName });
  await field.fill('Night');

  const listbox = page.getByRole('listbox', { name: 'Search suggestions' });
  await expect(listbox).toBeVisible();
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await expect(listbox.getByRole('option', { name: /Quiet Hours/ })).toBeVisible();
  await expect(page).toHaveURL(/\/finitude\/?$/);
  expect(api.calls.some((call) => call.pathname === '/api/listener/v1/search' && call.search === '?q=Night')).toBe(true);
  expect(await storedHistory(page)).toBeNull();

  // Search for, Artist, Album.
  await field.press('ArrowDown');
  await field.press('ArrowDown');
  await field.press('ArrowDown');
  const album = listbox.getByRole('option', { name: /Quiet Hours/ });
  await expect(album).toHaveAttribute('aria-selected', 'true');
  await expect(field).toHaveAttribute('aria-activedescendant', (await album.getAttribute('id'))!);
  await field.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/finitude/albums/${catalogIds.album}$`));
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toHaveCount(0);
  expect(await storedHistory(page)).toEqual(['Night']);
});

test('Enter without a highlight opens full results, and Escape closes suggestions', async ({ page }) => {
  await page.goto('/finitude');
  const field = page.getByRole('combobox', { name: fieldName });
  await field.fill('Dawn');
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toBeVisible();
  await field.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toHaveCount(0);
  await expect(field).toBeFocused();

  await field.press('Enter');
  await expect(page).toHaveURL(/\/finitude\/search\?q=Dawn$/);
  await expect(page.getByRole('heading', { name: 'Results for “Dawn”' })).toBeVisible();
  expect(await storedHistory(page)).toEqual(['Dawn']);

  // On the Search route the shell field drives the page and the duplicate page field is hidden.
  await expect(page.getByRole('main').getByRole('search', { name: 'Search results' })).toBeHidden();
  const filters = page.getByRole('group', { name: 'Search result types' });
  await filters.getByRole('button', { name: 'Albums' }).click();
  await expect(filters.getByRole('button', { name: 'Albums' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Artists' })).toHaveCount(0);

  await page.goto('/finitude');
  await page.getByRole('combobox', { name: fieldName }).focus();
  const recent = page.getByRole('listbox', { name: 'Search suggestions' });
  await expect(recent.getByRole('option', { name: /Dawn/ })).toBeVisible();
});
