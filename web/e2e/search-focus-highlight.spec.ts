import { expect, test } from './support/test';

test('highlights the complete Search bar when its input receives focus', async ({ page }) => {
  await page.goto('/listen/search');

  const searchBar = page.getByRole('search', { name: 'Search results' });
  const input = searchBar.getByRole('searchbox', {
    name: 'Search artists, albums, and soundtracks'
  });

  await input.focus();

  await expect(searchBar).toHaveCSS('border-color', 'rgb(158, 234, 221)');
  await expect(searchBar).toHaveCSS('box-shadow', 'rgb(158, 234, 221) 0px 0px 0px 1px inset');
  await expect(input).toHaveCSS('box-shadow', 'none');
  await expect(input).toHaveCSS('outline-style', 'none');
});
