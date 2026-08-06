import { expect, test } from './support/test';

test('highlights the complete Search bar when its input receives focus', async ({ page }) => {
  await page.goto('/finitude/search');

  const searchBar = page.getByRole('search', { name: 'Search results' });
  const input = searchBar.getByRole('searchbox', {
    name: 'Search artists, albums, and soundtracks'
  });

  await input.focus();

  expect(await searchBar.evaluate((element) => getComputedStyle(element)
    .getPropertyValue('--color-focus').trim())).not.toBe('');
  await expect.poll(async () => searchBar.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.borderColor !== 'rgba(0, 0, 0, 0)'
      && style.borderColor !== 'transparent'
      && style.boxShadow.includes(style.borderColor);
  })).toBe(true);
  await expect(input).toHaveCSS('box-shadow', 'none');
  await expect(input).toHaveCSS('outline-style', 'none');
});
