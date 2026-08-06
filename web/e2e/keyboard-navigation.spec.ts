import { catalogIds } from './fixtures/catalog';
import { privatePlaylistSummary } from './fixtures/privateListener';
import { expect, test } from './support/test';
import { installPrivateListenerRoutes } from './support/privateRoutes';

test('keeps the wide-shell Tab order deterministic through navigation and Library actions', async ({ browserName, page }) => {
  test.skip(browserName !== 'chromium', 'Chromium owns the deterministic keyboard-order baseline.');
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto('/finitude');
  await expect(page.getByRole('heading', { name: 'Browser Test Listening Room' })).toBeVisible();

  const sidebar = page.getByRole('complementary', { name: 'Finitude Library' });
  const expectedOrder = [
    page.getByRole('link', { name: 'Skip to main content' }),
    page.getByRole('link', { name: 'Finitude home' }),
    page.getByRole('button', { name: 'Go back' }),
    page.getByRole('button', { name: 'Go forward' }),
    page.getByRole('button', { name: 'Submit search' }),
    page.getByRole('searchbox', { name: 'Search artists, albums, and soundtracks' }).first(),
    page.getByRole('link', { name: 'Log in' }).first(),
    sidebar.getByRole('link', { name: 'Home' }),
    sidebar.getByRole('link', { name: 'Search' }),
    sidebar.getByRole('link', { name: 'Library' }),
    sidebar.getByRole('button', { name: 'New Playlist' })
  ];
  await expect(expectedOrder.at(-1)!).toBeEnabled();

  for (const target of expectedOrder) {
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  }
});

test('traps a signed-out Playlist dialog and returns focus after Escape', async ({ page }) => {
  await page.goto('/finitude/playlists');
  await expect(page.getByRole('heading', { name: 'Log in to open your Playlists' })).toBeVisible();

  const trigger = page.getByRole('main').getByRole('button', { name: 'New Playlist' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Log in to create a Playlist' });
  const close = dialog.getByRole('button', { name: 'Close' });
  const login = dialog.getByRole('link', { name: 'Log in' });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(login).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('supports menu arrow keys, dialog focus wrapping, Escape, and trigger focus return', async ({ page }) => {
  await installPrivateListenerRoutes(page);
  await page.goto('/finitude/playlists');
  await expect(page.getByRole('main').getByRole('link', {
    name: `${privatePlaylistSummary.name}, ${privatePlaylistSummary.itemCount} soundtracks`
  })).toBeVisible();

  const trigger = page.getByRole('main').getByRole('button', {
    name: `Actions for ${privatePlaylistSummary.name}`
  });
  await trigger.focus();
  await trigger.press('ArrowDown');
  const menu = page.getByRole('menu', { name: `Actions for ${privatePlaylistSummary.name}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename Playlist' });
  const input = dialog.getByRole('textbox', { name: 'Name' });
  const save = dialog.getByRole('button', { name: 'Save name' });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('does not intercept playback shortcuts while typing and restores help focus', async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(`/finitude/albums/${catalogIds.album}`);
  await page.getByRole('main')
    .locator('header')
    .getByRole('button', { name: 'Play', exact: true })
    .click();

  const player = page.getByRole('region', { name: 'Now playing' });
  const controls = player.getByRole('group', { name: 'Playback controls' });
  const pause = controls.getByRole('button', { name: 'Pause' });
  const play = controls.getByRole('button', { name: 'Play', exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(play).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search artists, albums, and soundtracks' }).first();
  await search.pressSequentially('ambient ');
  await expect(search).toHaveValue('ambient ');
  await expect(play).toBeVisible();

  await page.getByRole('main').focus();
  await page.keyboard.press('Space');
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(play).toBeVisible();

  const helpTrigger = player.getByRole('button', { name: 'Keyboard shortcuts' });
  await helpTrigger.click();
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(helpTrigger).toBeFocused();
});
